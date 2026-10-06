import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { code, createClient, type Client, type Transport } from './protocol';
import { ApprovalCard, type Ask } from './components/ApprovalCard';
import { Icon } from './components/Icon';
import { SettingsDialog } from './components/Settings';
import { RowView } from './components/RowView';
import { SessionRail } from './components/SessionRail';
import { UsageMeter } from './components/UsageMeter';
import { Palette, type Command } from './components/Palette';
import { hotkeyOf } from './hotkeys';
import type { Verbosity } from './components/types';
import { createSlotRegistry, SLOTS, type Panel } from './slots';
import { capabilityOf, changeOf, metaRow, projectRecord, type Record_, type Row } from './rows';
import type { Status } from './status';
import { readSettings, writeSettings, type Settings } from './settings';

type Branch = { seq: number; id: string; task: string };

// 流式期间的那半截排在已落盘的那些行之后，id 固定：每次增量都换 id 会让那一行重建，展开状态就丢了。
const LIVE_REASONING: Row = { id: -2, kind: 'reasoning', text: '' };
const LIVE_ANSWER: Row = { id: -1, kind: 'answer', text: '' };

// 一次挂进行里的最多行数：一份长转录先只画末尾那一段，早前的靠「显示更早」往前要（U48）。
// 不做虚拟化库：读数说明多少条开始画不动，窗口大小按那份读数调。
const RENDER_WINDOW = 400;

type PanelProps = {
  client: Client;
  status: Status | null;
  sessionId: string | null;
  running: boolean;
  seconds: number;
  waiting: number;
  counts: { sent: number; received: number };
  openSession: (id: string) => void;
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
];

// 还没有实现的三项：菜单里看得见，点开只说明缺的是哪一件，不做半只的开关。
const pendingPanels: Panel<PanelProps>[] = [
  {
    id: 'panel.policy',
    title: '审批规则',
    pending: true,
    view: () => <p className="stub">档位现在是整个运行一份，按工具名一份那一档没定（未定项 U22）。界面在这里放开关就等于替那条未定项做决定，所以先不放。</p>,
  },
  {
    id: 'panel.model',
    title: '模型与端点',
    pending: true,
    view: () => <p className="stub">服务地址与模型名读的是配置文件那三层（D8），协议表里那九条方法没有一条读写配置。这一项要先加方法，界面改配置才谈得上。设置那一个对话框里也写着这一条。</p>,
  },
  {
    id: 'panel.windows',
    title: '多窗口与重连',
    pending: true,
    view: () => <p className="stub">一份壳对应一个 Host 进程，会话状态在那个进程里（D30）。多个窗口看同一会话要等共享常驻进程引入（U8）；进程断掉之后记录里那批没结果的调用怎么补也没定（U21）。</p>,
  },
];

// 左侧栏那一项：读的是 `sessions.list`，挂的是声明好的那个槽位（D91、I7）。
const railPanels: Panel<PanelProps>[] = [
  {
    id: 'rail.sessions',
    title: '会话',
    view: ({ client, sessionId, openSession }) => <SessionRail client={client} current={sessionId} onOpen={openSession} />,
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
      <div className="conversation" data-verbosity={verbosity}>
        {shown.rows.map((row) => <RowView key={row.id} row={row} verbosity={verbosity} />)}
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
  const [draft, setDraft] = useState(() => readSettings().draft);
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
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const active = useRef<string | null>(null);
  // 跟随最新：贴在底部时新内容进来就滚到底；人往上翻过就不再自动滚，给一个跳回最新的按钮。
  const scroller = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);
  const [limit, setLimit] = useState(RENDER_WINDOW);
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

  const nearBottom = () => {
    const node = scroller.current;
    return node === null || node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  };

  useEffect(() => {
    const node = scroller.current;
    if (node !== null && pinned) node.scrollTop = node.scrollHeight;
  }, [rows, live, pinned]);

  const onScroll = useCallback(() => {
    setPinned(nearBottom());
  }, []);

  const jumpToLatest = useCallback(async () => {
    const node = scroller.current;
    if (node !== null) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    setPinned(true);
  }, []);

  useEffect(() => {
    active.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    writeSettings({ ...settings, draft });
  }, [draft, settings]);

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
      if (params?.sessionId !== active.current) return;
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

  const newSession = useCallback(async () => {
    try {
      const created = await client.call('session.create', {}) as { sessionId: string };
      setSessionId(created.sessionId);
      setRows([]);
      setLimit(RENDER_WINDOW);
      setLive({ text: '', reasoning: '' });
      setAsks([]);
      void refreshStatus(created.sessionId);
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `会话建不起来：${code(error)}`)]);
    }
  }, [client, refreshStatus]);

  useEffect(() => {
    void newSession();
  }, [newSession]);

  // 换会话先让 Host 那一份接上：记录不在磁盘上就是没有这份会话，`session.open` 会说清（D78）。
  // 已经打开的那一份复用状态，不重开，所以这一个动作对当前会话也是安全的。
  const openSession = useCallback(async (id: string) => {
    setSessionId(id);
    setRows([]);
    setLimit(RENDER_WINDOW);
    setLive({ text: '', reasoning: '' });
    setAsks([]);
    dispatchAt.current.clear();
    setReading(true);
    try {
      // 两条都带超时：那一边不回话时这一格要落到失败那一张脸，不能一直停在「在读那份记录…」。
      await client.call('session.open', { sessionId: id }, 15_000);
      // fullResults 那一格是给界面读的：溢出文件里的整段正文这才到得了画面（记录本身不动）。
      const { events } = await client.call('session.read', { sessionId: id, fullResults: true }, 15_000) as { events: Record_[] };
      setRows(events.flatMap((record) => projectRecord(record)));
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `那份会话接不上：${code(error)}`)]);
    } finally {
      setReading(false);
    }
    void refreshStatus(id);
  }, [client, refreshStatus]);

  const readBack = useCallback(async () => {
    if (sessionId === null) return;
    await openSession(sessionId);
  }, [sessionId, openSession]);

  const submit = useCallback(async (text: string) => {
    if (text === '' || sessionId === null || running) return;
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
      setRows((current) => [...current, metaRow('error', `这一轮停住：${code(error)}`)]);
    } finally {
      setRunning(false);
      setAsks([]);
      void refreshStatus(sessionId);
    }
  }, [client, history, refreshStatus, running, sessionId]);

  const send = useCallback(async () => {
    await submit(draft.trim());
  }, [draft, submit]);

  const cancel = useCallback(async () => {
    if (sessionId === null) return;
    try {
      await client.call('run.cancel', { sessionId });
    } catch (error) {
      setRows((current) => [...current, metaRow('meta', `取消没生效：${code(error)}`)]);
    }
  }, [client, sessionId]);

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
  ], [cancel, collapsed, copyLastAnswer, compact, newSession, patch, readBack, status]);

  const answer = useCallback((decision: 'allow' | 'deny') => {
    const [head, ...rest] = asks;
    if (head === undefined) return;
    setAsks(rest);
    // 先把这一条记在界面上再发答复：答复一发出去，Host 那一边就往下跑，工具结果可能比这一行先到。
    setRows((current) => [...current, metaRow('meta', `${decision === 'allow' ? '已允许' : '已不允许'} ${head.tool}${head.detail === '' ? '' : `：${head.detail.slice(0, 60)}`}`)]);
    client.reply(head.id, { decision });
  }, [asks, client]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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

  const panelProps: PanelProps = {
    client,
    status,
    sessionId,
    running,
    seconds,
    waiting: client.waiting(),
    counts: client.counts(),
    openSession,
    settings,
    patch,
  };
  const hidden = Math.max(0, rows.length - limit);

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

      <div className="conversation" data-verbosity={verbosity} aria-live="polite" ref={scroller} onScroll={onScroll}>
        <div className="stream">
          {reading && <p className="placeholder"><Icon name="clock" size={14} /> 在读那份记录…</p>}
          {!reading && rows.length === 0 && live.text === '' && <p className="placeholder"><Icon name="spark" size={14} /> 还没有轮次。下方输入一句话，Enter 直接开始。</p>}
          {hidden > 0 && <button type="button" className="earlier" onClick={() => setLimit((n) => n + RENDER_WINDOW)}>显示更早的 {hidden} 行</button>}
          {rows.slice(hidden).map((row) => <RowView key={row.id} row={row} verbosity={verbosity} />)}
          {/* 流式那半截排在已落盘的那些行之后：它是这一轮的末尾，画到开头去就把因果倒过来了。 */}
          {live.reasoning !== '' && <RowView row={{ ...LIVE_REASONING, text: live.reasoning }} verbosity={verbosity} />}
          {live.text !== '' && <RowView row={{ ...LIVE_ANSWER, text: live.text }} verbosity={verbosity} />}
        </div>
      </div>
      {!pinned && <button className="jump-latest" type="button" onClick={() => void jumpToLatest()}>回到最新</button>}

      {asks.length > 0 && <ApprovalCard
        ask={asks[0]}
        queued={asks.length - 1}
        verbosity={verbosity}
        policy={status?.policy ?? 'ask'}
        onAnswer={answer}
      />}

      {link !== null && <div className="banner" role="alert">
        <Icon name="warn" size={15} />
        <strong>这一条连接不在了</strong>
        <code>{link}</code>
        <span>这一侧只能再问一次；把后端进程重新起来是壳的事，那一条命令还没有（U51）。</span>
        <button type="button" onClick={() => void beat(4_000)}>重问一次</button>
      </div>}

      <footer className="composer">
        <textarea
          className="composer-input"
          ref={composerRef}
          rows={3}
          value={draft}
          placeholder="要模型做的事（Enter 发送，Shift+Enter 换行，空草稿上 ↑↓ 翻历史）"
          onChange={(event) => {
            setDraft(event.target.value);
            setWalk(-1);
          }}
          onKeyDown={(event) => {
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
          <button className="send" type="button" title="发送（Enter）" aria-label="发送" disabled={running || sessionId === null} onClick={() => void send()}><Icon name="send" size={17} /></button>
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
      onRetry={() => void beat(4_000)}
      onClose={() => setSettingsOpen(false)}
    />}
  </div>;
}
