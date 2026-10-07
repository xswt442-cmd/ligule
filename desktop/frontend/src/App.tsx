import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type ItemProps, type VirtuosoHandle } from 'react-virtuoso';
import { code, createClient, type Client, type Transport } from './protocol';
import { ApprovalCard, type Ask } from './components/ApprovalCard';
import { Icon } from './components/Icon';
import { SettingsDialog } from './components/Settings';
import { RowView } from './components/RowView';
import { SessionRail, type SearchHit } from './components/SessionRail';
import { ModelPanel } from './components/ModelPanel';
import { UsageMeter } from './components/UsageMeter';
import { Palette, type Command } from './components/Palette';
import { hotkeyOf, isComposing } from './hotkeys';
import { insertMention, mentionToken } from './mentions';
import type { Verbosity } from './components/types';
import { createSlotRegistry, SLOTS, type Panel } from './slots';
import { capabilityOf, changeOf, metaRow, projectRecord, shownIn, type Record_, type Row } from './rows';
import type { Status } from './status';
import { readSettings, writeSettings, type Settings } from './settings';

type Branch = { seq: number; id: string; task: string };

// 流式期间的那半截排在已落盘的那些行之后，id 固定：每次增量都换 id 会让那一行重建，展开状态就丢了。
const LIVE_REASONING: Row = { id: -2, kind: 'reasoning', text: '' };
const LIVE_ANSWER: Row = { id: -1, kind: 'answer', text: '' };

// 一次往前要一页的事件数：打开一份会话读最近这一页，更早的按游标继续要（方案 4.1）。
const RENDER_WINDOW = 400;
// 虚拟视口里第一条的起始编号：往前插一页就把它减去插进去的行数，那一条的序号在插页前后不变，视口就停在它上面（U48）。
// 这一格要留成正数，所以从一个足够大的数起，而不是直接用记录的序号。
const FIRST_INDEX = 100_000;

type PanelProps = {
  client: Client;
  status: Status | null;
  sessionId: string | null;
  running: boolean;
  seconds: number;
  waiting: number;
  counts: { sent: number; received: number };
  openSession: (id: string) => void;
  // 查找命中说的是一份会话里的第几条：接上那一份，再跳到那一行（方案 4.2）。
  openHit: (hit: SearchHit) => void;
  // 宿主多出一份记录时（分支之后）左侧栏重读一次的信号（方案 4.3）。
  sessionsRevision: number;
  settings: Settings;
  patch: (part: Partial<Settings>) => void;
};

const HISTORY_KEY = 'ligule.input-history';
const HISTORY_MAX = 50;

// 本机存的那一份是不可信的输入：读坏了就当没有。
function readHistory(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

// 已经接上的四项。
const menuPanels: Panel<PanelProps>[] = [
  {
    id: 'panel.status',
    title: '工具与档位',
    view: ({ status }) => status === null
      ? <p className="stub">还没有会话，读不到状态。</p>
      : <>
        <h3>模式 {status.mode ?? '没有装'} · 档位 {status.policy} · 工具 {status.tools.length} 件 · 记录 {status.eventCount} 条 · {status.running ? '正在跑' : '空闲'}</h3>
        <p className="stub">判定链记下的不允许：连续 {status.denials.consecutive} 次、累计 {status.denials.total} 次。连续次数到阈值时档位自己回到逐次询问（D17）。</p>
        <ul>{status.tools.map((name) => <li key={name}>{name}</li>)}</ul>
      </>,
  },
  {
    id: 'panel.shortcuts',
    title: '快捷键',
    view: () => <ul>
      <li>Enter —— 发送</li>
      <li>Shift+Enter —— 换行</li>
      <li>Ctrl+Enter —— 发送</li>
      <li>Esc —— 依次关掉命令面板、设置、菜单、右侧面板；都关完时打断正在跑的那一轮</li>
    </ul>,
  },
  {
    id: 'panel.frames',
    title: '这一条连接',
    view: ({ counts, waiting, sessionId }) => <>
      <ul>
        <li>发出的帧：{counts.sent}</li>
        <li>收到的帧：{counts.received}</li>
        <li>还没答复的调用：{waiting}</li>
        <li>当前会话：{sessionId ?? '没有'}</li>
      </ul>
      <p className="stub">载体是标准输入输出两根管道，本机没有监听端口（D30）；界面拿不到地址与凭据。</p>
    </>,
  },
  {
    id: 'panel.branch',
    title: '派生支线',
    view: ({ client, sessionId, settings }) => <BranchPanel client={client} sessionId={sessionId} verbosity={settings.verbosity} />,
  },
  {
    id: 'panel.model',
    title: '模型与端点',
    view: ({ client }) => <ModelPanel client={client} />,
  },
];

// 还没有实现的两项：菜单里看得见，点开只说明缺的是哪一件，不做半只的开关。
const pendingPanels: Panel<PanelProps>[] = [
  {
    id: 'panel.policy',
    title: '审批规则',
    pending: true,
    view: () => <p className="stub">档位是整个运行一份，逐件收紧走配置里的规则表，那条已经定了（U41、U22）。这一格要放开关，得先有写配置的方法：协议里现在只有读配置的那一条（`config.get`）。</p>,
  },
  {
    id: 'panel.windows',
    title: '多窗口与重连',
    pending: true,
    view: () => <p className="stub">一份壳对应一个 Host 进程，会话状态在那个进程里（D30）。后端进程退了可以重连：那一个动作换一具进程，再用 `session.open` 接回这一份会话（第 65 步）。多个窗口看同一会话要等共享常驻进程引入（U8）。</p>,
  },
];

// 左侧栏那一项：读的是 `sessions.list`，挂的是声明好的那个槽位（D91、I7）。
const railPanels: Panel<PanelProps>[] = [
  {
    id: 'rail.sessions',
    title: '会话',
    view: ({ client, sessionId, openSession, openHit, sessionsRevision }) => (
      <SessionRail client={client} current={sessionId} onOpen={openSession} onOpenHit={openHit} revision={sessionsRevision} />
    ),
  },
];

const statusPanels: Panel<PanelProps>[] = [
  {
    id: 'status.pills',
    title: '运行状态',
    // 顶栏只说这一份会话现在在做什么；工具件数、记录条数与拒绝计数在设置那一个对话框里（D98）。
    view: ({ status, running, waiting, seconds }) => <>
      {running && <span className="pill" data-tone="running">正在跑 {seconds} 秒</span>}
      {waiting > 0 && <span className="pill" title="发出去还没回来的调用">未答的调用 {waiting}</span>}
      {status !== null && <>
        <span className="pill">模式 {status.mode ?? '没装'}{status.pendingMode === null || status.pendingMode === undefined ? '' : `→${status.pendingMode}`}</span>
        <span className="pill">档位 {status.policy}</span>
        {status.denials.total > 0 && <span className="pill">不允许 {status.denials.consecutive}/{status.denials.total}</span>}
      </>}
    </>,
  },
  {
    id: 'status.usage',
    title: '上下文用量',
    view: ({ status, running, seconds }) => {
      const usage = status?.usage;
      // 窗口那一格没写时两条压缩触发都不启用，这一格也就没有压力线可画（D75）。
      return usage === undefined || usage === null
        ? <span className="pill" title="限额那一格没写，两条压缩触发都不启用">窗口没写</span>
        : <UsageMeter usage={usage} running={running} seconds={seconds} />;
    },
  },
];

// 派生支线（D74）：入口作为一个面板挂进类型化槽位，渲染主干不写支线这件事。
// 支线 id 读自父记录那条 subagent 结果，读它用的还是那一次读记录的动作——协议表里没为支线加方法。
function branchOf(record: Record_): Branch | null {
  if (record.kind !== 'tool' || record.tool !== 'subagent') return null;
  const content = record.result?.content as { sessionId?: unknown } | undefined;
  if (typeof content?.sessionId !== 'string' || content.sessionId === '') return null;
  return { seq: record.seq ?? 0, id: content.sessionId, task: String(record.args?.task ?? '') };
}

function BranchPanel({ client, sessionId, verbosity }: { client: Client; sessionId: string | null; verbosity: Verbosity }) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [shown, setShown] = useState<{ id: string; rows: Row[] } | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    setBranches([]);
    setShown(null);
    setNote('');
    if (sessionId === null) return;
    // 每次打开面板重扫一遍父记录：派生体跑完才有那条结果，第一版不做实时流（D74）。
    void (async () => {
      try {
        const { events } = await client.call('session.read', { sessionId, fullResults: true }) as { events: Record_[] };
        setBranches(events.map(branchOf).filter((item): item is Branch => item !== null));
      } catch (error) {
        setNote(`父记录读不回来：${code(error)}`);
      }
    })();
  }, [client, sessionId]);

  const open = useCallback(async (id: string) => {
    setNote('');
    try {
      const { events } = await client.call('session.read', { sessionId: id, fullResults: true }) as { events: Record_[] };
      setShown({ id, rows: events.flatMap((record) => projectRecord(record)) });
    } catch (error) {
      setNote(`支线读不回来：${code(error)}`);
    }
  }, [client]);

  if (branches.length === 0) {
    return <p className="stub">{note === '' ? '这一份会话还没有派生支线。模型调用 subagent 之后，那条结果里就带着支线的会话 id。' : note}</p>;
  }
  return <>
    <h3>主线里的 {branches.length} 次派生</h3>
    <ul>{branches.map((branch) => <li key={branch.id}>
      <button type="button" onClick={() => void open(branch.id)}>第 {branch.seq} 条</button>
      <span className="muted"> {branch.task === '' ? '（没有留下任务文本）' : branch.task.slice(0, 60)}</span>
    </li>)}</ul>
    {shown !== null && <>
      <h3>支线 {shown.id} · 下面这些序号属于支线自己</h3>
      <div className="conversation">
        {shown.rows.filter((row) => shownIn(verbosity, row)).map((row) => <RowView key={row.id} row={row} verbosity={verbosity} />)}
      </div>
    </>}
    {note !== '' && <p className="stub">{note}</p>}
  </>;
}

export function App({ transport }: { transport: Transport }) {
  const client = useMemo(() => createClient(transport), [transport]);
  const registry = useMemo(() => {
    const created = createSlotRegistry<PanelProps>(SLOTS);
    for (const panel of [...menuPanels, ...pendingPanels]) created.register('rail.menu', panel);
    for (const panel of statusPanels) created.register('header.status', panel);
    for (const panel of railPanels) created.register('rail.sessions', panel);
    return created;
  }, []);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [live, setLive] = useState({ text: '', reasoning: '' });
  // 跑着的时候新到的询问排在后面：一次问一件事，答一件再画下一件。
  const [asks, setAsks] = useState<Ask[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  // 落笔处那一段 `@` 路径引用的候选：清单由宿主列出来，界面不开盘（方案 5.3、D81 边界一）。
  const [mention, setMention] = useState<null | { start: number; text: string; paths: string[]; chosen: number; stopped: string; failed?: string }>(null);
  // Esc 收起的是当下这一个词：接着改字会重新问，原样不动时不再弹出来挡住输入。
  const [hiddenMention, setHiddenMention] = useState('');
  const mentionWanted = useRef({ start: -1, text: '' });
  // 草稿与队列存本机时用的那一个项目身份，读自那份记录的头部；写不进去说过一次就不再重复。
  const [projectRoot, setProjectRoot] = useState('');
  // 屏幕上这一格草稿属于哪一份会话：接一份会话要等两次调用回来才摊开它自己的那一格，
  // 中间那一段里 `sessionId` 已经换了而草稿还是上一份的——那时保存会把上一句写进新的那一份名下。
  const [inputOwner, setInputOwner] = useState<string | null>(null);
  const saveWarned = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<Panel<PanelProps> | null>(null);
  const [settings, setSettings] = useState(readSettings);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const verbosity = settings.verbosity;
  const collapsed = settings.collapsed;
  // 输入历史留在本机（D90）：-1 说的是当前那份草稿。
  const [history, setHistory] = useState(readHistory);
  const [walk, setWalk] = useState(-1);
  // 运行中敲进去的那几句排在界面这一侧：每份会话各排各的，取消这一轮之后停下等一次显式的继续（方案 5.2）。
  const [queues, setQueues] = useState<Record<string, { items: string[]; paused: boolean }>>({});
  const queue = queues[sessionId ?? ''] ?? { items: [] as string[], paused: false };
  const patchQueue = useCallback((own: string, next: (current: { items: string[]; paused: boolean }) => { items: string[]; paused: boolean }) => {
    setQueues((current) => ({ ...current, [own]: next(current[own] ?? { items: [], paused: false }) }));
  }, []);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const active = useRef<string | null>(null);
  // 跟随最新：画面停在最后一行时新内容进来就滚到底；人往上翻过就不再自动滚，给一个跳回最新的按钮。
  const list = useRef<VirtuosoHandle | null>(null);
  const [pinned, setPinned] = useState(true);
  // 历史读到哪一条了：`before` 是这一页最早那一条事件的序号，`hasMore` 说宿主那一边还有没有更早的（方案 4.1）。
  // 界面手里只有读过的这几页，整份记录留在宿主那一边（实现顺序第 73 步）。
  const [page, setPage] = useState<{ before: number; hasMore: boolean } | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const [firstIndex, setFirstIndex] = useState(FIRST_INDEX);
  // 画面要落到哪一条：查找的命中，或者上一次读到的那一个位置（方案 4.2、6.2）。
  const [wanted, setWanted] = useState<{ sessionId: string; seq: number; kind: string } | null>(null);
  const [stamp, setStamp] = useState(0);
  // 分支写完一份新记录，左侧栏要重读一次才说得出它存在（方案 4.3）；这一枚编号就是那一次重读的信号。
  const [sessionsRevision, setSessionsRevision] = useState(0);
  // 每一份会话读到哪儿了：键是会话编号，值是画面最上面那一行的事件序号。切回来时还在手里这一页之内才落回去。
  const anchors = useRef(new Map<string, number>());
  // 这一次读的是哪一份记录的答复：中途又切走时，旧的那一份答复不能落到新的画面上（方案 6.2）。
  const opening = useRef<string | null>(null);
  // 跳到的那一行亮一小段：一屏里几十行都在，不落个记号认不出停在哪一条。
  const [flash, setFlash] = useState<number | null>(null);
  // 那一次派发是什么时候交出去的：只为算用时，键是调用 id（D94）。
  const dispatchAt = useRef(new Map<string, number>());
  const [seconds, setSeconds] = useState(0);
  // 这一条连接还在不在：null 是在，其余是那一侧报回来的说法（D93 原样带出）。
  const [link, setLink] = useState<string | null>(null);

  // 本轮计时：跑着的时候一秒走一格，本轮结束（完成或被打断）就归零。
  useEffect(() => {
    if (!running) {
      setSeconds(0);
      return;
    }
    const tick = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(tick);
  }, [running]);

  // 每 3 秒问一次状态：那是协议里已有的一条只读调用，答不上来就是这一条连接不在了。
  // 界面这一侧只能重问一次；后端进程起不来那一段是壳的事，协议表里没有那一条命令。
  const beat = useCallback(async (timeoutMs = 5_000) => {
    if (sessionId === null) return;
    try {
      await client.call('status.get', { sessionId }, timeoutMs);
      setLink(null);
    } catch (error) {
      setLink(code(error));
    }
  }, [client, sessionId]);

  useEffect(() => {
    transport.onFault?.((reason) => setLink(reason));
    if (sessionId === null) return;
    const timer = setInterval(() => void beat(), 3_000);
    return () => clearInterval(timer);
  }, [beat, sessionId, transport]);

  // 接上一份会话时落在最后一行：读回来的那一页本来就是末尾那一段，停在顶上等于没接上（D95）。
  // 新内容进来只在本来就在最后一行时跟着滚到底，那是 `followOutput` 那一格管的（U48）。
  useEffect(() => {
    if (reading || rows.length === 0) return;
    list.current?.scrollToIndex({ index: 'LAST' });
  }, [reading, sessionId]);

  const jumpToLatest = useCallback(() => {
    list.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
    setPinned(true);
  }, []);

  // 「显示更早」要的那一页仍在宿主那一边：游标是这一页最早那一条事件的序号，它稳定也单调，
  // 所以翻页期间新到的事实在末尾追加，手里这一页不重复也不漏（方案 4.1、实现顺序第 73 步）。
  const showEarlier = useCallback(async () => {
    if (sessionId === null || page === null || !page.hasMore || olderLoading) return;
    setOlderLoading(true);
    try {
      const older = await client.call('session.read',
        { sessionId, before: page.before, limit: RENDER_WINDOW, fullResults: true }, 15_000) as { events: Record_[]; hasMore: boolean };
      // 这一页读回来的时候人已经切走了：过期答复不改新画面的行数，也不动它的游标（方案 6.2）。
      if (opening.current !== sessionId) return;
      const added = older.events.flatMap((record) => projectRecord(record));
      // 往前插一页要同时把起始编号减去插进去的行数：那一行的序号在插页前后不变，视口就停在它上面（U48）。
      setFirstIndex((current) => current - added.length);
      setRows((current) => [...added, ...current]);
      setPage({ before: older.events.length === 0 ? page.before : Number(older.events[0]?.seq), hasMore: older.hasMore });
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `更早的那一页读不来：${code(error)}`)]);
    } finally {
      setOlderLoading(false);
    }
  }, [client, olderLoading, page, sessionId]);

  useEffect(() => {
    active.current = sessionId;
  }, [sessionId]);

  // 草稿与排着的几句按「哪一项目录下的哪一份会话」存本机：切换、打开设置、看历史与断连都不丢这一句，
  // 退出再打开时接得回来（方案 5.1）。写不进去要说一句，别让人以为它已经存住了。
  useEffect(() => {
    if (sessionId === null || inputOwner !== sessionId) return;
    const stored = readSettings();
    // 空的那一格不留：草稿清空、队列发完，那一行整个从存储里去掉，不留着旧内容。
    const put = <T extends { length: number }>(table: Record<string, Record<string, T>>, value: T): Record<string, Record<string, T>> => {
      const row = { ...(table[projectRoot] ?? {}) };
      if (value.length === 0) delete row[sessionId];
      else row[sessionId] = value;
      const next = { ...table };
      if (Object.keys(row).length === 0) delete next[projectRoot];
      else next[projectRoot] = row;
      return next;
    };
    const items = queues[sessionId]?.items ?? [];
    if (writeSettings({ ...settings, drafts: put(stored.drafts, draft), queued: put(stored.queued, items) })) return;
    if (saveWarned.current) return;
    saveWarned.current = true;
    setRows((current) => [...current, metaRow('error', '这一句在屏幕上留着，但本机那一份存储写不进去：退出再打开时它不会回来')]);
  }, [draft, inputOwner, projectRoot, queues, sessionId, settings]);

  // 主题、字号与侧栏宽度落在根元素上：那一份 CSS 变量在 `:root` 那一格读（D90）。
  useEffect(() => {
    const root = document.documentElement;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const light = settings.theme === 'light' || (settings.theme === 'system' && !query.matches);
    root.dataset.theme = light ? 'light' : 'dark';
    root.dataset.font = settings.font;
    root.style.setProperty('--sidebar', `${settings.sidebar}px`);
    if (settings.theme !== 'system') return;
    const follow = (event: MediaQueryListEvent) => {
      root.dataset.theme = event.matches ? 'dark' : 'light';
    };
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, [settings.font, settings.sidebar, settings.theme]);

  const patch = useCallback((part: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...part }));
  }, []);

  // 拖那一条分隔线改侧栏宽度：范围与设置面板里那根滑杆是同一份（D90）。
  const startDrag = useCallback((event: { clientX: number }) => {
    const startX = event.clientX;
    const startWidth = settings.sidebar;
    const move = (moveEvent: PointerEvent) => {
      patch({ sidebar: Math.min(420, Math.max(264, startWidth + moveEvent.clientX - startX)) });
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  }, [patch, settings.sidebar]);

  useEffect(() => {
    client.onNotification((message) => {
      if (message.notify === 'fault') {
        setRows((current) => [...current, metaRow('error', `连接上的问题：${message.code} ${message.detail ?? ''}`)]);
        return;
      }
      if (message.sessionId !== active.current) return;
      if (message.notify === 'delta') {
        const event = message.event as { type?: string; text?: string } | undefined;
        if (event?.type === 'text') setLive((current) => ({ ...current, text: current.text + (event.text ?? '') }));
        else if (event?.type === 'reasoning') setLive((current) => ({ ...current, reasoning: current.reasoning + (event.text ?? '') }));
        return;
      }
      if (message.notify === 'event') {
        const record = message.event as Record_;
        // 刚落盘的那一条取代流式期间的那半截：记录是事实源（I5）。
        if (record?.kind === 'assistant') {
          setLive((current) => ({ ...current, text: '' }));
          for (const call of record.toolCalls ?? []) dispatchAt.current.set(call.id, Date.now());
        }
        if (record?.kind === 'reasoning') setLive((current) => ({ ...current, reasoning: '' }));
        // 记录里不带逐条时间戳，用时这一格只有界面活着的那一轮量得到（D94、U50）。
        const started = record?.kind === 'tool' && record.callId !== undefined ? dispatchAt.current.get(record.callId) : undefined;
        if (started !== undefined && record?.callId !== undefined) dispatchAt.current.delete(record.callId);
        const added = projectRecord(record, started === undefined ? {} : { startedAt: started });
        if (added.length > 0) setRows((current) => [...current, ...added]);
      }
    });

    client.onRequest((message) => {
      // Host 朝界面发出去的请求只有 approval.request 这一种。
      if (message.method !== 'approval.request') return;
      const params = message.params as { sessionId?: string; tool?: string; command?: string; args?: Record<string, unknown>; reason?: string; shell?: string; executable?: string };
      // 询问归那一份会话，不归眼前看着的那一份：别的那一份在等，也得让人看得见、答得掉（实现顺序第 71 步）。
      const asked = params?.sessionId;
      if (typeof asked !== 'string' || asked === '') return;
      const tool = params.tool ?? '';
      const args = params.args ?? {};
      // 画出来的那一句说的是哪个对象：命令文本、路径、目标地址，或者那一项 MCP 能力名（D67）。
      const detail = String(params.command ?? args.path ?? args.url ?? capabilityOf(tool, args));
      const content = tool === 'edit'
        ? `原内容：\n${String(args.anchor ?? '')}\n\n新内容：\n${String(args.replacement ?? '')}`
        : typeof args.content === 'string'
          ? args.content
          // 命令文本在 `command` 那一格，参数这一格是空的：空的就不给一个展开把手。
          : Object.keys(args).length === 0 ? '' : JSON.stringify(args, null, 2);
      setAsks((current) => [...current, {
        id: message.id ?? '',
        sessionId: asked,
        tool,
        detail,
        change: changeOf(tool, args).summary,
        reason: params.reason ?? '',
        // 用哪一种语法判的、跑的是哪一个可执行文件：答的是这一条命令，看得见的该是这两样（D59）。
        backend: params.shell === undefined ? '' : `${params.shell} · ${params.executable ?? ''}`,
        content,
      }]);
    });

    // 后端进程的标准错误输出走到这里：它不是协议帧，是那一侧打印的东西。
    transport.onLog((line) => setRows((current) => [...current, metaRow('meta', `宿主输出：${line}`)]));
  }, [client, transport]);

  const refreshStatus = useCallback(async (id: string) => {
    try {
      setStatus(await client.call('status.get', { sessionId: id }) as Status);
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `状态读不到：${code(error)}`)]);
    }
  }, [client]);

  // 询问是宿主那一侧在等的一件事，不随看着的是哪一份会话而变化：换走时不清空，否则那一条派发给谁答。
  // 只有那一轮自己收尾（跑完、被打断）或那具宿主换掉时，才收掉它名下的那些询问。
  const dropAsksOf = useCallback((id: string) => setAsks((current) => current.filter((ask) => ask.sessionId !== id)), [setAsks]);

  // 换会话先让 Host 那一份接上：记录不在磁盘上就是没有这份会话，`session.open` 会说清（D78）。
  // 已经打开的那一份复用状态，不重开，所以这一个动作对当前会话也是安全的。
  // 给了 `hit` 就一口气往回读到那一条进来，并把「要落到哪一条」与那些行同一批交出去：
  // 数据先变长、跳转晚一帧的话，贴在末行那一条会先把画面拉回去（U48、方案 6.2）。
  const openSession = useCallback(async (id: string, hit?: SearchHit) => {
    opening.current = id;
    setSessionId(id);
    setRows([]);
    setPage(null);
    setFirstIndex(FIRST_INDEX);
    setLive({ text: '', reasoning: '' });
    setWanted(null);
    setInputOwner(null);
    dispatchAt.current.clear();
    setReading(true);
    try {
      // 两条都带超时：那一边不回话时要显示失败那一种状态，不能一直停在「在读那份记录…」。
      await client.call('session.open', { sessionId: id }, 15_000);
      // fullResults 那一格是给界面读的：溢出文件里的整段正文这才到得了画面（记录本身不动）。
      // 只取最近这一页：更早的靠「显示更早」那一格按游标往前要（方案 4.1、实现顺序第 73 步）。
      const newest = await client.call('session.read', { sessionId: id, limit: RENDER_WINDOW, fullResults: true }, 15_000) as { events: Record_[]; hasMore: boolean; header: { projectRoot?: string } | null };
      if (opening.current !== id) return;
      // 接上这一份时把它自己那两格摊回来：草稿是当时没发出去的那一句，排着的几条恢复成暂停（方案 5.1、5.2）。
      const root = newest.header?.projectRoot ?? '';
      setProjectRoot(root);
      const stored = readSettings();
      setDraft(stored.drafts[root]?.[id] ?? '');
      const restored = stored.queued[root]?.[id] ?? [];
      patchQueue(id, () => ({ items: restored, paused: restored.length > 0 }));
      setInputOwner(id);
      let events = newest.events;
      let hasMore = newest.hasMore;
      while (hit !== undefined && hit.seq < Number(events[0]?.seq ?? 0) && hasMore) {
        const older = await client.call('session.read',
          { sessionId: id, before: Number(events[0]?.seq), limit: RENDER_WINDOW, fullResults: true }, 15_000) as { events: Record_[]; hasMore: boolean };
        // 人在这几页读回来的时候切走了：这一份答复过期，不落到新的画面上（方案 6.2）。
        if (opening.current !== id) return;
        if (older.events.length === 0) { hasMore = false; break; }
        events = [...older.events, ...events];
        hasMore = older.hasMore;
      }
      setRows(events.flatMap((record) => projectRecord(record)));
      setPage({ before: Number(events[0]?.seq ?? 1), hasMore });
      // 上一次读到的位置还在手里这一页之内就落回去；落不回就停在末尾，不替他改展示档，也不往前多读页。
      const anchor = anchors.current.get(id);
      const back = anchor !== undefined && anchor > Number(events[0]?.seq) && anchor < Number(events.at(-1)?.seq)
        ? { sessionId: id, seq: anchor, kind: 'anchor' }
        : null;
      setWanted(hit ?? back);
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `那份会话接不上：${code(error)}`)]);
    } finally {
      setReading(false);
    }
    void refreshStatus(id);
  }, [client, refreshStatus]);

  const newSession = useCallback(async () => {
    try {
      const created = await client.call('session.create', {}) as { sessionId: string };
      // 新建那一份也走接会话那一条路：只有那一次读把记录头部的项目根带回来，草稿与队列才知道该存到哪一格。
      void openSession(created.sessionId);
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `会话建不起来：${code(error)}`)]);
    }
  }, [client, openSession]);

  useEffect(() => {
    void newSession();
  }, [newSession]);

  // 查找命中那一条交给接会话那一个动作：读到位与落笔在同一批里，跳转那一处只认这一份会话的第几条（方案 4.2）。
  const openHit = useCallback((hit: SearchHit) => void openSession(hit.sessionId, hit), [openSession]);

  // 两个分支入口共用这一处：不给 `at` 是整份复制——复制到的就是这一刻记录落到哪儿为止；
  // 给一个轮次标记就是复制到那一轮为止。父那一份一个字不动（方案 4.3）。
  const branchFrom = useCallback(async (at?: number) => {
    if (sessionId === null) return;
    try {
      const branched = await client.call('session.branch', { sessionId, ...(at === undefined ? {} : { at }) }, 15_000) as { sessionId: string; at: number };
      await openSession(branched.sessionId);
      setSessionsRevision((current) => current + 1);
      setRows((current) => [...current, metaRow('meta', `复制成一份新的会话 ${branched.sessionId.slice(0, 8)}：带到第 ${branched.at} 条为止，原来那一份不动。`)]);
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `分支没成：${code(error)}`)]);
    }
  }, [client, openSession, sessionId]);

  // 重连（实现顺序第 65 步）：旧的那一具宿主不会再答复了，先把发出去的请求按一个稳定码收尾，
  // 把没答的询问作废，再让壳换一具进程，最后用 `session.open` 接回原来那一份会话。
  const reconnect = useCallback(async () => {
    client.discard('host_restarted');
    setAsks([]);
    setRunning(false);
    try {
      await transport.restart?.();
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `后端进程起不来：${code(error)}`)]);
      return;
    }
    if (sessionId !== null) await openSession(sessionId);
  }, [client, openSession, sessionId, setAsks, setRunning, transport]);

  const readBack = useCallback(async () => {
    if (sessionId === null) return;
    await openSession(sessionId);
  }, [sessionId, openSession]);

  const submit = useCallback(async (text: string) => {
    if (text === '' || sessionId === null) return;
    // 跑着的那一轮里回车不丢话：那一句排在界面这一侧，本轮结束后按先后发出（方案 5.2、D81 边界二：不进记录）。
    if (running) {
      setDraft('');
      setWalk(-1);
      patchQueue(sessionId, (current) => ({ ...current, items: [...current.items, text] }));
      return;
    }
    setDraft('');
    setWalk(-1);
    const remembered = [text, ...history.filter((item) => item !== text)].slice(0, HISTORY_MAX);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(remembered));
    setHistory(remembered);
    setRunning(true);
    try {
      const result = await client.call('run.start', { sessionId, input: text }) as { iterations: number; modelCalls: number; completedBy?: string };
      setRows((current) => [...current, metaRow('meta', `本轮结束：${result.iterations} 次迭代、${result.modelCalls} 次模型调用${result.completedBy === undefined ? '' : `，由 ${result.completedBy} 收尾`}`)]);
    } catch (error) {
      const stopped = code(error);
      // 打断落在还在跑的模型调用上时端点那一头交回 `provider_cancelled`，落在两组调用之间才是 `loop_cancelled`：
      // 人要读的是同一句——这一轮是他停下来的（方案 5.2）。
      const cancelled = stopped === 'loop_cancelled' || stopped === 'provider_cancelled';
      setRows((current) => [...current, metaRow(cancelled ? 'meta' : 'error', cancelled ? '这一轮已被打断' : `这一轮停住：${stopped}`)]);
    } finally {
      setRunning(false);
      // 这一轮收尾了：它名下那些没答的询问由宿主按「不允许」结了，界面上不再留着让人去答。
      dropAsksOf(sessionId);
      void refreshStatus(sessionId);
    }
  }, [client, dropAsksOf, history, patchQueue, refreshStatus, running, sessionId]);

  // 本轮收尾后把排着的第一条发出去：一次只发一条。暂停着就一条也不发——那几句是人在跑着的时候敲进来的，
  // 他按下的是取消，剩下怎么走要他再说一次（方案 5.2）。
  useEffect(() => {
    if (running || sessionId === null) return;
    const own = queues[sessionId];
    if (own === undefined || own.paused || own.items.length === 0) return;
    const [next, ...rest] = own.items;
    patchQueue(sessionId, () => ({ items: rest, paused: false }));
    void submit(next);
  }, [patchQueue, queues, running, sessionId, submit]);

  // 收回来的那一句回到草稿：草稿上还有字时不动它，界面不把两句拼在一起（方案 5.2「取消项仍能恢复文本」）。
  const recoverQueueItem = useCallback((index: number, all: boolean) => {
    if (sessionId === null || draft !== '') return;
    const own = queues[sessionId] ?? { items: [], paused: false };
    if (own.items.length === 0) return;
    const recovered = all ? own.items.join('\n\n') : own.items[index] ?? '';
    if (recovered === '') return;
    setDraft(recovered);
    setWalk(-1);
    patchQueue(sessionId, all
      ? () => ({ items: [], paused: false })
      : (current) => ({ ...current, items: current.items.filter((_, at) => at !== index) }));
  }, [draft, patchQueue, queues, sessionId]);

  const send = useCallback(async () => {
    await submit(draft.trim());
  }, [draft, submit]);

  const cancel = useCallback(async () => {
    if (sessionId === null) return;
    // 按下取消就是「剩下的别自己走」：那几条留在这儿，等一次显式的继续（方案 5.2）。
    if ((queues[sessionId]?.items.length ?? 0) > 0) patchQueue(sessionId, (current) => ({ ...current, paused: true }));
    try {
      await client.call('run.cancel', { sessionId });
    } catch (error) {
      setRows((current) => [...current, metaRow('meta', `取消没生效：${code(error)}`)]);
    }
  }, [client, patchQueue, queues, sessionId]);

  // 等手停下 160 毫秒问一次；答回来时那一段已经改了就把那一次丢掉。传输那一层没有中途取消，
  // 所以 5.3 那一条「慢请求可取消」在这儿做到的是不落到画面上。
  useEffect(() => {
    const token = mentionToken(draft, caret);
    if (token === null) { setMention(null); return; }
    mentionWanted.current = token;
    if (hiddenMention === token.text) return;
    if (mention !== null && mention.start === token.start && mention.text === token.text) return;
    const timer = setTimeout(() => {
      void (async () => {
        const listed = await client.call('paths.list', { projectRoot, query: token.text, limit: 8 }, 8_000)
          .then((answer) => ({ ...(answer as { paths: string[]; stopped: string }), failed: undefined as string | undefined }))
          .catch((error) => ({ paths: [], stopped: 'error', failed: code(error) }));
        const now = mentionWanted.current;
        if (now.start !== token.start || now.text !== token.text) return;
        setMention({ ...token, paths: listed.paths, chosen: 0, stopped: listed.stopped, failed: listed.failed });
      })();
    }, 160);
    return () => clearTimeout(timer);
  }, [caret, client, draft, hiddenMention, mention, projectRoot]);

  // 选中一条候选：那一段 `@…` 换成 `@路径␣`，笔落到那一段之后，后面已写的字不动（方案 5.3）。
  const pickMention = useCallback((path: string) => {
    if (mention === null) return;
    const merged = insertMention(draft, caret, mention.start, path);
    setDraft(merged.draft);
    setCaret(merged.caret);
    setHiddenMention('');
    setMention(null);
    composerRef.current?.setSelectionRange(merged.caret, merged.caret);
    composerRef.current?.focus();
  }, [caret, draft, mention]);

  // 切模式走协议里那一条 `mode.set`（D65）：坏清单在那一刻就报稳定码，不静默换成随包的那一份。
  const setMode = useCallback(async (name: string) => {
    if (sessionId === null || name === '') return;
    try {
      const result = await client.call('mode.set', { sessionId, name }) as { mode: string; pending: string | null };
      setRows((current) => [...current, metaRow('meta', result.pending === null
        ? `模式 ${result.mode} 已生效`
        : `模式 ${result.pending} 等本轮结束生效`)]);
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `模式换不了：${code(error)}`)]);
    }
    void refreshStatus(sessionId);
  }, [client, refreshStatus, sessionId]);

  // 手动压缩走 `session.compact`（D83）：压的是模型那一份上下文，画面上的行仍然来自整份记录。
  const compact = useCallback(async () => {
    if (sessionId === null) return;
    try {
      const result = await client.call('session.compact', { sessionId }) as { fromSeq: number; toSeq: number; tokensBefore: number; tokensAfter: number };
      setRows((current) => [...current, metaRow('meta', `压掉第 ${result.fromSeq} 到 ${result.toSeq} 条：${result.tokensBefore} → ${result.tokensAfter}`)]);
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `压缩没成：${code(error)}`)]);
    }
    void refreshStatus(sessionId);
  }, [client, refreshStatus, sessionId]);

  const copyLastAnswer = useCallback(() => {
    const answer = [...rows].reverse().find((row) => row.kind === 'answer');
    if (answer === undefined) {
      setRows((current) => [...current, metaRow('meta', '记录里还没有一条带正文的回答')]);
      return;
    }
    void navigator.clipboard.writeText(answer.text).then(
      () => setRows((current) => [...current, metaRow('meta', `已复制最后那条回答（${answer.text.length} 字）`)]),
      (error: unknown) => setRows((current) => [...current, metaRow('error', `复制没成：${code(error)}`)]),
    );
  }, [rows]);

  // 命令面板只做入口：那一条落下去的还是界面本来就会做的那一件事（D92）。
  const commands = useMemo<Command[]>(() => [
    { id: 'session.new', title: '新建会话', note: 'session.create', run: () => void newSession() },
    { id: 'session.read', title: '读回这一份记录', note: 'session.read', run: () => void readBack() },
    { id: 'session.branch', title: '分支这一份会话', note: 'session.branch：复制到此刻记录落到哪儿为止', run: () => void branchFrom() },
    { id: 'run.cancel', title: '取消这一轮', note: 'run.cancel', run: () => void cancel() },
    { id: 'session.compact', title: '手动压缩上下文', note: 'session.compact', run: () => void compact() },
    { id: 'settings.open', title: '打开设置', note: '外观、模式、审批规则、连接', run: () => setSettingsOpen(true) },
    { id: 'rail.toggle', title: collapsed ? '展开左侧栏' : '收起左侧栏', note: 'Ctrl+B', run: () => patch({ collapsed: !collapsed }) },
    { id: 'answer.copy', title: '复制最后那条回答', note: 'Ctrl+Shift+C', run: copyLastAnswer },
    ...(status?.templates ?? []).map((item) => ({
      id: `prompt:${item.command}`,
      title: `填一条 /${item.command}`,
      note: item.hint === null || item.hint === undefined ? item.description : `${item.description} ${item.hint}`,
      run: () => {
        setDraft(`/${item.command} `);
        setWalk(-1);
        composerRef.current?.focus();
      },
    })),
  ], [branchFrom, cancel, collapsed, copyLastAnswer, compact, newSession, patch, readBack, status]);

  const answer = useCallback((decision: 'allow' | 'deny') => {
    const [head, ...rest] = asks;
    if (head === undefined) return;
    setAsks(rest);
    // 答复按那一次请求的编号回去，看着的是哪一份会话不影响它落到哪一轮。
    // 回声那一行只画在它自己那一份会话的转录里：别的那一份的答复不属于眼前这一段。
    if (head.sessionId === sessionId) {
      // 先把这一条记在界面上再发答复：答复一发出去，Host 那一边就往下跑，工具结果可能比这一行先到。
      setRows((current) => [...current, metaRow('meta', `${decision === 'allow' ? '已允许' : '已不允许'} ${head.tool}${head.detail === '' ? '' : `：${head.detail.slice(0, 60)}`}`)]);
    }
    client.reply(head.id, { decision });
  }, [asks, client, sessionId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 输入法正在拼的那一段里，Esc 属于取消候选词，Enter 属于选中候选词：这一路都不能替人收面板或打断这一轮（方案 5.1、5.4）。
      if (isComposing(event)) return;
      const hot = hotkeyOf(event);
      if (hot !== null) {
        event.preventDefault();
        if (hot === 'palette') setPaletteOpen((open) => !open);
        else if (hot === 'sidebar') patch({ collapsed: !collapsed });
        else copyLastAnswer();
        return;
      }
      if (event.key !== 'Escape') return;
      if (paletteOpen) setPaletteOpen(false);
      else if (settingsOpen) setSettingsOpen(false);
      else if (menuOpen) setMenuOpen(false);
      else if (panel !== null) setPanel(null);
      else if (running) void cancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cancel, collapsed, copyLastAnswer, menuOpen, panel, paletteOpen, patch, running, settingsOpen]);

  // 虚拟视口的三件外壳（U48、方案 6.2）：每一条都要占住转录那一条 74 字的居中列，所以 `Item` 自己包一层。
  // 身份用 `useMemo` 稳住：每次渲染都换一个新组件会让视口把挂着的行重建一遍。
  const viewport = useMemo(() => ({
    // 换外壳要连着 Virtuoso 读尺寸用的那几格 `data-*` 一起递出去，只转 children 与 style 会让它量不到行高（U48）。
    Item: ({ children, style, ...rest }: ItemProps<Row>) => <div {...rest} style={style} className="stream-row">{children}</div>,
    Header: () => <div className="stream-band">
      {page?.hasMore === true && <button type="button" className="earlier" disabled={olderLoading} onClick={() => void showEarlier()}>
        {olderLoading ? '在读更早的一页…' : '显示更早的一页'}
      </button>}
    </div>,
    EmptyState: () => <div className="stream-band">{reading
      ? <p className="placeholder"><Icon name="clock" size={14} /> 在读那份记录…</p>
      : <p className="placeholder"><Icon name="spark" size={14} /> 还没有轮次。下方输入一句话，Enter 直接开始。</p>}</div>,
  }), [olderLoading, page, reading, showEarlier]);
  // 展示档没放进来那几类行不进列表：虚拟视口要量每一行的高度，藏着不画的行留在列表里只会量到零（D90、U48）。
  const shown = useMemo(() => rows.filter((row) => shownIn(verbosity, row)), [rows, verbosity]);
  // 流式那半截排在已落盘的那些行之后：它是这一轮的末尾，画到开头去就把因果倒过来了。
  const visible = live.reasoning === '' && live.text === '' ? shown : [
    ...shown,
    ...(live.reasoning === '' || !shownIn(verbosity, LIVE_REASONING) ? [] : [{ ...LIVE_REASONING, text: live.reasoning }]),
    ...(live.text === '' || !shownIn(verbosity, LIVE_ANSWER) ? [] : [{ ...LIVE_ANSWER, text: live.text }]),
  ];

  // 命中落在手里这几页之外：由 `openSession` 往回读到位再落笔，所以这一处只负责画面（方案 6.2）。
  // 跳转靠换一枚 `stamp` 让视口重新挂载，并从 `jumpAt` 那一条开始画：数据刚变长时视口自己要先量一遍行高，
  // 同一帧里发出的 `scrollToIndex` 会被它随后那一次回到末行盖掉（U48）。
  useEffect(() => {
    if (wanted === null) return;
    const at = visible.findIndex((row) => row.seq === wanted.seq);
    if (at >= 0) {
      setStamp((current) => current + 1);
      setFlash(wanted.seq);
      return;
    }
    // 上一次读到的那一行不在画出来的这几类里（展示档筛掉了它）：就停在末尾，不替他改档位，也不在转录里写字。
    if (wanted.kind === 'anchor') {
      setWanted(null);
      return;
    }
    // 记录里有这一行而画面上没有：是当前展示档把那一类行筛掉了，收到全量才看得见它（D90）。
    const held = rows.find((row) => row.seq === wanted.seq);
    if (held !== undefined && !shownIn(verbosity, held)) {
      patch({ verbosity: 'detailed' });
      return;
    }
    // 读到的那几页里没有这一行：它不画在转录里（比如它是一份会话的名字）。说出来，不让人等一次不会来的跳转。
    setWanted(null);
    setRows((current) => [...current, metaRow('meta', `第 ${wanted.seq} 条不在这份转录里：${wanted.kind === 'label' ? '那一条是这一份会话的名字，名字画在标题与列表那一处' : '它不在这一份记录读得到的那几类里'}`)]);
  }, [patch, rows, verbosity, visible, wanted]);

  // 那一段亮只亮一会儿：它说的是「跳到这一条」，不是「这一条与别的那些不一样」。
  // `stamp` 也在读数里：连着跳同一行时那一个值不变，不看它就没法重新起那一段计时。
  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => {
      setFlash(null);
      setWanted(null);
    }, 2500);
    return () => clearTimeout(timer);
  }, [flash, stamp]);

  // 要落的那一条在数据里的位置：`stamp` 换掉的那一帧视口重新挂载，就从这一条开始画。
  const jumpAt = wanted === null ? -1 : visible.findIndex((row) => row.seq === wanted.seq);

  const panelProps: PanelProps = {
    client,
    status,
    sessionId,
    running,
    seconds,
    waiting: client.waiting(),
    counts: client.counts(),
    openSession,
    openHit,
    sessionsRevision,
    settings,
    patch,
  };

  return <div className="frame" data-collapsed={collapsed ? 'true' : undefined} data-dock={settings.dock}>
    <aside className="sidebar">
      <div className="brand"><img src="/icon.png" alt="" width="22" height="22" /><span>ligule</span></div>
      <button className="new-run" type="button" onClick={() => void newSession()}><Icon name="plus" size={15} /><span>新建会话</span></button>
      <div className="section-label">会话</div>
      {registry.list('rail.sessions').map((item) => <div key={item.id} className="rail-slot">{item.view(panelProps)}</div>)}
      <div className="sidebar-foot">
        <button className="entry" type="button" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)}><Icon name="gear" size={15} /><span>设置</span></button>
        <button className="entry" type="button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
          <Icon name="grid" size={15} /><span>功能</span>
        </button>
      </div>
    </aside>
    <div className="splitter" role="separator" aria-orientation="vertical" aria-label="侧栏宽度" onPointerDown={startDrag} />

    <main className="center">
      <header className="topbar">
        <div className="title">
          <strong id="session-title">{sessionId === null ? '没有会话' : `会话 ${sessionId.slice(0, 8)}`}</strong>
          <span className="muted" id="session-note">{status === null ? '还没有会话：新建一份，或者从左侧栏挑一份' : `记录 ${status.eventCount} 条`}</span>
        </div>
        <div className="pills">{registry.list('header.status').map((item) => <span key={item.id}>{item.view(panelProps)}</span>)}</div>
        <button className="icon-button" type="button" title="命令面板（Ctrl+K）" aria-label="命令面板" onClick={() => setPaletteOpen(true)}><Icon name="search" size={15} /></button>
      </header>

      {/* 转录只挂视口里那几十行：读回来的那一页全在数据里，画出来的由视口决定（U48、方案 6.2）。 */}
      <div className="conversation" aria-live="polite">
        <Virtuoso
          key={`stream-${stamp}`}
          ref={list}
          style={{ height: '100%' }}
          data={visible}
          firstItemIndex={firstIndex}
          initialTopMostItemIndex={jumpAt < 0 ? undefined : { index: jumpAt, align: 'start' }}
          computeItemKey={(_index, row) => row.id}
          itemContent={(_index, row) => <RowView
            row={row}
            verbosity={verbosity}
            flash={row.seq !== undefined && row.seq === flash}
            branch={row.kind === 'round' ? (at) => void branchFrom(at) : undefined}
          />}
          // 一次查找的跳转期间不跟末行：往前要页与展示档那一次收全都会让数据变长，
          // 而跟末行那一条会把刚落下的那一行重新推走（方案 6.2）。
          followOutput={(atBottom) => (atBottom && wanted === null && flash === null ? 'smooth' : false)}
          atBottomThreshold={40}
          atBottomStateChange={(atBottom) => setPinned(atBottom)}
          rangeChanged={({ startIndex }) => {
            // 记住这一份会话读到哪儿：画面最上面那一行的事件序号，切回来时按它落回去（方案 6.2）。
            const row = visible[startIndex - firstIndex];
            if (row?.seq !== undefined && sessionId !== null) anchors.current.set(sessionId, row.seq);
          }}
          increaseViewportBy={{ top: 240, bottom: 600 }}
          components={viewport}
        />
      </div>
      {!pinned && <button className="jump-latest" type="button" onClick={jumpToLatest}>回到最新</button>}

      {asks.length > 0 && <ApprovalCard
        ask={asks[0]}
        queued={asks.length - 1}
        verbosity={verbosity}
        policy={status?.policy ?? 'ask'}
        active={sessionId}
        onOpen={(id: string) => void openSession(id)}
        onAnswer={answer}
      />}

      {link !== null && <div className="banner" role="alert">
        <Icon name="warn" size={15} />
        <strong>这一条连接不在了</strong>
        <code>{link}</code>
        <span>重连会换一具后端进程。没答复的那些请求按 `host_restarted` 收尾，还没答的询问作废，这一份会话接回来。</span>
        <button type="button" onClick={() => void reconnect()}>重连</button>
      </div>}

      <footer className="composer">
        {queue.items.length === 0 ? null : (
          <div className="queue">
            <div className="queue-head">
              <span className="mini">排队 {queue.items.length} 条 · {queue.paused ? '暂停中：这一轮是你停下来的，剩下的不自己发' : '这一轮结束后按先后发出'}</span>
              <button type="button" className="mini chip" title={queue.paused ? '接着把排着的发出去' : '先停下，排着的几条都不发'}
                onClick={() => { if (sessionId !== null) patchQueue(sessionId, (current) => ({ ...current, paused: !current.paused })); }}>
                {queue.paused ? '继续' : '暂停'}
              </button>
              <button type="button" className="mini chip" disabled={draft !== ''}
                title={draft === '' ? '把这几条都收回草稿，中间空一行分开' : '草稿上还有字：先把它发出去或排起来，界面不把两句拼在一起'}
                onClick={() => recoverQueueItem(0, true)}>全部收回</button>
            </div>
            {queue.items.map((item, index) => (
              <div className="queue-item" key={`${index}:${item}`}>
                <span className="queue-text">{item}</span>
                <button type="button" className="mini chip" disabled={draft !== ''}
                  title={draft === '' ? '收回草稿，队列少一条' : '草稿上还有字：先把它发出去或排起来，界面不把两句拼在一起'}
                  onClick={() => recoverQueueItem(index, false)}>收回</button>
              </div>
            ))}
          </div>
        )}
        {mention === null ? null : (
          <div className="queue" role="listbox" aria-label="项目里的文件">
            {mention.paths.length === 0 ? (
              <span className="mini">{mention.stopped === 'error'
                ? `这个项目列不出文件：${mention.failed}`
                : `这个项目里没有文件名含「${mention.text}」的文件`}</span>
            ) : mention.paths.map((path, index) => (
              <div className="queue-item" key={path} role="option" aria-selected={index === mention.chosen}>
                <span className="queue-text">{path}</span>
                <button type="button" className="mini chip" onClick={() => pickMention(path)}>插入</button>
              </div>
            ))}
            {mention.paths.length > 0 && mention.stopped === 'budget'
              && <span className="mini">只翻了前面那些文件，更深的没看到：把字写得更具体一些</span>}
            {mention.paths.length > 0 && mention.stopped === 'unreadable'
              && <span className="mini">有一层目录读不了，这份清单不一定全</span>}
            {mention.paths.length > 0 && <span className="mini">Enter 或 Tab 选中 · ↑↓ 换一条 · Esc 收起</span>}
          </div>
        )}
        <textarea
          className="composer-input"
          ref={composerRef}
          rows={3}
          value={draft}
          placeholder="要模型做的事（Enter 发送，跑着的时候排到后面，Shift+Enter 换行，空草稿上 ↑↓ 翻历史，打 @ 引用项目里的文件）"
          onChange={(event) => {
            setDraft(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
            setWalk(-1);
          }}
          // 落笔处也认：点一下别处或用方向键挪笔时，那一段 `@` 可能已经不是原来那一段了。
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onKeyDown={(event) => {
            // 组合期间的 Enter 与上下键都是候选词那一路的按键，界面不接：不发这一句，也不翻本机历史（方案 5.1）。
            if (isComposing(event.nativeEvent)) return;
            // 路径候选开着时这几记按键归清单：Enter 是选中那一条，不是发送（方案 5.3「选中候选不能触发发送」）。
            // 一条候选都没有时 Enter 照旧发这一句——那时那一栏说的是「没有对得上的文件」，不该把发送挡住。
            if (mention !== null && mention.paths.length > 0) {
              if (event.key === 'Escape') {
                setHiddenMention(mention.text);
                setMention(null);
                return;
              }
              if (event.key === 'Tab' || event.key === 'Enter') {
                event.preventDefault();
                pickMention(mention.paths[Math.min(mention.chosen, mention.paths.length - 1)]);
                return;
              }
              if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault();
                const step = event.key === 'ArrowUp' ? -1 : 1;
                setMention({ ...mention, chosen: (mention.chosen + step + mention.paths.length) % mention.paths.length });
              }
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
              return;
            }
            // 只在空草稿或已经在历史里走的时候接这两个键：否则它们该移动光标。
            if ((event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || (draft !== '' && walk < 0)) return;
            if (history.length === 0) return;
            event.preventDefault();
            const next = event.key === 'ArrowUp' ? Math.min(walk + 1, history.length - 1) : walk - 1;
            setWalk(next);
            setDraft(next < 0 ? '' : history[Math.max(next, 0)] ?? '');
          }}
        />
        <div className="composer-bar">
          <button type="button" className="mini chip" title="切模式在设置那个对话框里" onClick={() => setSettingsOpen(true)}>
            模式 <b>{status?.mode ?? '没装'}</b>
          </button>
          <span className="bar-spacer" />
          <button className="icon-button" type="button" title="读回这一份记录" aria-label="读回记录" onClick={() => void readBack()}><Icon name="refresh" size={15} /></button>
          <button className="icon-button" type="button" title="复制最后那条回答（Ctrl+Shift+C）" aria-label="复制回答" onClick={copyLastAnswer}><Icon name="copy" size={15} /></button>
          <button className="icon-button" type="button" title="取消这一轮（Esc）" aria-label="取消本轮" disabled={!running} onClick={() => void cancel()}><Icon name="stop" size={15} /></button>
          <button className="send" type="button" title={running ? '排到后面（这一轮结束后发出）' : '发送（Enter）'} aria-label="发送" disabled={sessionId === null} onClick={() => void send()}><Icon name="send" size={17} /></button>
        </div>
      </footer>
      <div className="statusbar">
        <span>管道 · 发出 {panelProps.counts.sent} 条 · 收到 {panelProps.counts.received} 条</span>
        <span>{running ? `正在跑 ${seconds} 秒` : '空闲'}</span>
        <span>{sessionId === null ? '没有会话' : `会话 ${sessionId}`}</span>
      </div>
    </main>

    {panel !== null && <aside className="dock">
      <div className="dock-head">
        <strong className="dock-title">{panel.title}{panel.pending === true && <span className="menu-tag">待实现</span>}</strong>
        <button type="button" className="icon-button" aria-label="关闭面板" onClick={() => setPanel(null)}><Icon name="close" size={15} /></button>
      </div>
      <div className="dock-body">{panel.view(panelProps)}</div>
    </aside>}

    {menuOpen && <div className="menu" role="menu">
      {registry.list('rail.menu').map((item) => <button
        key={item.id}
        type="button"
        role="menuitem"
        onClick={() => {
          setPanel(item);
          setMenuOpen(false);
        }}
      >{item.title}{item.pending === true && <span className="menu-tag">待实现</span>}</button>)}
    </div>}
    {paletteOpen && <Palette commands={commands} onClose={() => setPaletteOpen(false)} />}
    {settingsOpen && <SettingsDialog
      status={status}
      settings={settings}
      patch={patch}
      link={link}
      counts={panelProps.counts}
      waiting={panelProps.waiting}
      onSetMode={(name) => void setMode(name)}
      onReconnect={() => void reconnect()}
      onClose={() => setSettingsOpen(false)}
    />}
  </div>;
}
