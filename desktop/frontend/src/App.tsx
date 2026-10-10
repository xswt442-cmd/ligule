import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DropdownMenu, Popover } from 'radix-ui';
import { Virtuoso, type ItemProps, type VirtuosoHandle } from 'react-virtuoso';
import { code, createClient, type Client, type Transport } from './protocol';
import { ApprovalCard, type Ask } from './components/ApprovalCard';
import { QuestionCard, type QuestionAsk, type QuestionDrafts } from './components/QuestionCard';
import { Icon } from './components/Icon';
import { SettingsDialog } from './components/Settings';
import { RowView } from './components/RowView';
import { SessionRail, type SearchHit } from './components/SessionRail';
import { createCallOf, type WorkspaceRoster } from './rail';
import { SessionMenu } from './components/SessionMenu';
import { ModelPanel } from './components/ModelPanel';
import { ExportPanel } from './components/ExportPanel';
import { HelpPanel } from './components/HelpPanel';
import { UsageMeter } from './components/UsageMeter';
import { Palette, type Command } from './components/Palette';
import { keepEscape } from './components/ui';
import { KEYMAP, CURRENT, actionOf, formatKeys, isCapturing, isComposing, loadBindings, specOf } from './hotkeys';
import { insertMention, mentionToken } from './mentions';
import type { Verbosity } from './components/types';
import { createSlotRegistry, SLOTS, type Panel } from './slots';
import { capabilityOf, changeBody, changeOf, metaRow, projectRecord, questionEcho, shownIn, type Record_, type Row } from './rows';
import type { Status } from './status';
import { mergeQueueIntoDraft, readSettings, writeSettings, type Settings } from './settings';

type Branch = { seq: number; id: string; task: string };

// 流式期间的那半截排在已落盘的那些行之后，id 固定：每次增量都换 id 会让那一行重建，展开状态就丢了。
const LIVE_REASONING: Row = { id: -2, kind: 'reasoning', text: '' };
const LIVE_ANSWER: Row = { id: -1, kind: 'answer', text: '' };

// 一次往前要一页的事件数：打开一份会话读最近这一页，更早的按游标继续要（方案 4.1）。
const RENDER_WINDOW = 400;
// 虚拟视口里第一条的起始编号：往前插一页就把它减去插进去的行数，那一条的序号在插页前后不变，视口就停在它上面（U48）。
// 这一格要留成正数，所以从一个足够大的数起：往前每插一页就从它里面减掉插进去的行数，起得太小会减成负数。
const FIRST_INDEX = 100_000;

type PanelProps = {
  client: Client;
  status: Status | null;
  sessionId: string | null;
  running: boolean;
  // 别的那些会话里还有几轮在跑：顶栏那一枚牌子要说得出「另一份也在跑」（方案 3.1「后台会话继续运行」）。
  othersRunning: number;
  // 左侧栏要按会话画出「这一份在跑」与「刚跑完一轮没看着」：这两格都是界面手里的运行事实（方案 3.1 的侧栏那一串）。
  runningIds: string[];
  unread: string[];
  // 这一扇窗口另外看着哪几项目录（方案 3.2）：那份清单存在界面偏好里，加与去都写回它。
  projects: string[];
  onProjects: (roots: string[]) => void;
  // 这一份窗口现在看着的那一份会话属于哪一个项目：配置那两栏读与写都跟着它（方案 3.2、审阅 F3）。
  projectRoot: string;
  // 在那一份项目里新建一份会话：不给目录就落在这一具宿主自己的项目（方案 3.2）。
  createIn: (root?: string) => void;
  seconds: number;
  waiting: number;
  counts: { sent: number; received: number };
  openSession: (id: string, projectRoot?: string) => void;
  // 查找命中说的是一份会话里的第几条：接上那一份，再跳到那一行（方案 4.2）。
  openHit: (hit: SearchHit, projectRoot?: string) => void;
  // 宿主多出一份记录时（分支之后）左侧栏重读一次的信号（方案 4.3）。
  sessionsRevision: number;
  settings: Settings;
  patch: (part: Partial<Settings>) => void;
};

// 「没在问哪一段」的形状：真实的落笔处起点不可能是 -1，所以它跟任何一段都对不上。
const NO_TOKEN = { start: -1, text: '' };
// 交给视口的那几个对象要稳住身份：每渲染一个新对象会被当成新值，短记录上那几次重排会连成死循环（第 105 步）。
const VIEWPORT_INCREASE = { top: 240, bottom: 600 };

// 已经接上的几项。右侧那一片面板说的是这一份会话现在的情况，与会话浮层里能改的那几格不重复摆控制。
/**
 * 那份持久登记里默认那一具的目录（方案 5.5.1、5.5.3）：没设过默认、读不回来都算「没有」。
 * 桌面不拿宿主继承的进程目录当自己的工作区，所以第一份会话落在这一格上，而不是落在 cwd。
 */
async function defaultWorkspaceOf(client: Client): Promise<string | undefined> {
  const roster = await client.call('workspaces.list', {}, 15_000).catch(() => null) as WorkspaceRoster | null;
  return roster === null ? undefined : roster.workspaces.find((one) => one.identity === roster.default)?.directory;
}

/**
 * 首次使用那一次：向壳要系统文档目录下那一具默认工作区，并把这份选择写进那份登记，让它下次启动还在、左侧栏也看得见（方案 5.5.3）。
 * 取不到、建不成或登记没写成，都交回那一句原因——静默改用别的目录是这一格明令不许的。
 */
async function registerShellWorkspace(getDirectory: () => Promise<string>, client: Client): Promise<{ directory?: string; failed?: string }> {
  try {
    const directory = await getDirectory();
    await client.call('workspace.default.set', { directory }, 15_000);
    return { directory };
  } catch (error) {
    return { failed: String((error as { message?: unknown })?.message ?? error) };
  }
}

const menuPanels: Panel<PanelProps>[] = [
  {
    id: 'panel.status',
    title: '工具与档位',
    view: ({ status }) => status === null
      ? <p className="stub">还没有会话，读不到状态。</p>
      : <>
        <div className="region-group">
          <h3>这一份会话</h3>
          <p className="stub">
            模式 {status.mode ?? '没有装'}。审批档位 {status.policy}，来自{status.policySource === 'session' ? '这一份会话改的' : '配置默认'}。
            现在{status.running ? '正在跑' : '空闲'}。记录里一共 {status.eventCount} 条。
            判定链记下的不允许：连续 {status.denials.consecutive} 次、累计 {status.denials.total} 次。连续次数到阈值时档位自己回到逐次询问。
          </p>
        </div>
        <div className="region-group">
          <h3>装着的工具（{status.tools.length} 件）</h3>
          <ul>{status.tools.map((name) => <li key={name}>{name}</li>)}</ul>
        </div>
      </>,
  },
  {
    id: 'panel.shortcuts',
    title: '快捷键',
    // 这一份清单读的是当前那一份键位表：键、动作与它落在哪一个范围，界面上说的和按键落的同一处取（方案 6.1）。
    view: () => <ul>{(Object.keys(KEYMAP) as (keyof typeof KEYMAP)[]).map((action) => (
      <li key={action}>{formatKeys(CURRENT[action])} —— {KEYMAP[action].label}（{KEYMAP[action].view}）</li>
    ))}</ul>,
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
      <p className="stub">载体是标准输入输出两根管道，本机没有监听端口。界面拿不到地址与凭据。</p>
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
    view: ({ client, sessionId, projectRoot }) => <ModelPanel client={client} sessionId={sessionId} projectRoot={projectRoot} />,
  },
  {
    id: 'panel.export',
    title: '导出全文',
    view: ({ client, sessionId }) => <ExportPanel client={client} sessionId={sessionId} />,
  },
  {
    id: 'panel.help',
    title: '使用手册',
    // 读的是随包的两份手册正文，不读磁盘、不等站点：这一栏与当前会话无关，所以不用任何 props。
    view: () => <HelpPanel />,
  },
];

// 还没有实现的那一项：菜单里看得见，点开说的是缺的那一件在哪。多窗看同一会话要等共享常驻进程引入。
const pendingPanels: Panel<PanelProps>[] = [
  {
    id: 'panel.windows',
    title: '多窗口与重连',
    pending: true,
    view: () => <p className="stub">一份壳对应一个 Host 进程，会话状态在那个进程里。后端进程退了可以重连：重连会换一具进程，再用 <code>session.open</code> 接回这一份会话。多个窗口看同一份会话还没有做。</p>,
  },
];

// 左侧栏那一项：读的是 `sessions.list`，挂的是声明好的那个槽位（D91、I7）。
const railPanels: Panel<PanelProps>[] = [
  {
    id: 'rail.sessions',
    title: '会话',
    view: ({ client, sessionId, openSession, openHit, sessionsRevision, runningIds, unread, projects, onProjects, createIn }) => (
      <SessionRail client={client} current={sessionId} onOpen={openSession} onOpenHit={openHit} revision={sessionsRevision} running={runningIds} unread={unread} projects={projects} onProjects={onProjects} onCreate={createIn} />
    ),
  },
];

const statusPanels: Panel<PanelProps>[] = [
  {
    id: 'status.pills',
    title: '运行状态',
    // 顶栏只说这一份会话现在在做什么；工具件数、记录条数与拒绝计数在设置那一个对话框里（D98）。
    view: ({ status, running, othersRunning, waiting, seconds }) => <>
      {running && <span className="pill" data-tone="running">正在跑 {seconds} 秒</span>}
      {othersRunning > 0 && <span className="pill" title="别的那些会话各有自己的轮次在跑：切过去看它自己那一份">另一份在跑 {othersRunning} 份</span>}
      {waiting > 0 && <span className="pill" title="发出去还没回来的调用">还没答复的调用 {waiting}</span>}
      {status !== null && <>
        <Popover.Trigger asChild><button className="pill" type="button" title="打开这一份会话的设置">模式 {status.mode ?? '没装'}{status.pendingMode === null || status.pendingMode === undefined ? '' : ` → ${status.pendingMode}`}</button></Popover.Trigger>
        <Popover.Trigger asChild><button className="pill" type="button" title="打开这一份会话的设置">审批 {status.policy}</button></Popover.Trigger>
        {status.denials.total > 0 && <span className="pill">不允许 连续 {status.denials.consecutive} 次 · 累计 {status.denials.total} 次</span>}
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
  // 流式那半截按会话各存一份：后台那一轮的片段留着，切回来先补上它，不等那一条落进记录（方案 3.1、审阅 F4）。
  const liveBySession = useRef(new Map<string, { text: string; reasoning: string }>());
  // 跑着的时候新到的询问排在后面：一次问一件事，答一件再画下一件。
  const [asks, setAsks] = useState<Ask[]>([]);
  // 本轮收尾时要知道那一份会话还剩几条没答：这一格由渲染之后同步，不在那一条收尾路径的依赖里读 `asks`（那会读到旧的一份）。
  const asksLeft = useRef<Ask[]>([]);
  useEffect(() => { asksLeft.current = asks; }, [asks]);
  // 模型的提问与审批各一张卡、各一条链：审批答「能不能做这一件」，提问答「这一件事该怎么办」（D107）。
  const [queries, setQueries] = useState<QuestionAsk[]>([]);
  // 与审批那一条收尾同一格做法：收尾的路径要说出那一份会话还剩几道题没交，也要拿到已经打下的字（审阅 F2）。
  const queriesLeft = useRef<QuestionAsk[]>([]);
  useEffect(() => { queriesLeft.current = queries; }, [queries]);
  // 一张卡上打下的字一路送到这一格：卡片收掉之后题面与那些字留成转录里的一条记录，而那张卡不再能提交（方案 R1）。
  const questionDrafts = useRef(new Map<string, QuestionDrafts>());
  // 收尾时那一份会话不在眼前：那一句留在它自己名下，等下一次接它时一起落下。
  const pendingEchoes = useRef(new Map<string, string[]>());
  const keepQuestionDraft = useCallback((id: string, drafts: QuestionDrafts) => { questionDrafts.current.set(id, drafts); }, []);
  // 跑着的那几轮各属于哪一份会话（方案 3.1「后台会话继续运行」与 5.2「队列按会话隔离」）：
  // 一具 Host 给每份会话自己的信号与判定链（`state.running` 按会话存），界面这一侧也跟着按会话记，
  // 「本轮结束」与那几句画面只说得上它自己那一份会话；切走看着另一份时不替那一份发话、也不替那一份画收尾。
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const running = sessionId !== null && runningIds.includes(sessionId);
  const othersRunning = runningIds.filter((id) => id !== sessionId).length;
  // 每一轮什么时候起的：顶上那枚「正在跑几秒」说的是眼前这一份的那一轮，不是别的那一份的。
  const roundStart = useRef(new Map<string, number>());
  const [tick, setTick] = useState(Date.now());
  const seconds = sessionId === null ? 0 : Math.max(0, Math.floor((tick - (roundStart.current.get(sessionId) ?? tick)) / 1000));
  // 某一轮收尾时人不在那一份的画面上：那份会话在左侧栏里挂一个「刚跑完一轮」的记号，切过去就消（方案 3.1 的未读结果）。
  const [unread, setUnread] = useState<string[]>([]);
  // 该发队首的那些会话：自己那一轮收尾时记下它自己，人按下「继续发」时记下眼前这一份。
  // 别的那一份的轮次结束时记下的是它自己，眼前这一份对不上，因此不会被它带着发出去（方案 5.2 那句）。
  // 这一格用 ref 不用 state：它只在「已经有别的东西重渲染」的那一次被读，不需要自己推动渲染。
  const allowSend = useRef(new Set<string>());
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  // 落笔处那一段 `@` 路径引用的候选：清单由宿主列出来，界面不开盘（方案 5.3、D81 边界一）。
  const [mention, setMention] = useState<null | { start: number; text: string; paths: string[]; chosen: number; stopped: string; root: string; failed?: string }>(null);
  // Esc 收起的是当下这一个词：接着改字会重新问，原样不动时不再弹出来挡住输入。
  const [hiddenMention, setHiddenMention] = useState('');
  const mentionWanted = useRef(NO_TOKEN);
  const mentionAsked = useRef(NO_TOKEN);
  // 草稿与队列存本机时用的那一个项目身份，读自那份记录的头部；写不进去说过一次就不再重复。
  const [projectRoot, setProjectRoot] = useState('');
  // 屏幕上这一格草稿属于哪一份会话：接一份会话要等两次调用回来才摊开它自己的那一格，
  // 中间那一段里 `sessionId` 已经换了而草稿还是上一份的——那时保存会把上一句写进新的那一份名下。
  const [inputOwner, setInputOwner] = useState<string | null>(null);
  const saveWarned = useRef(false);
  // 重连进行中：这一段时间里不发任何排着的句子，也不让「本轮结束就发队首」那一条 effect 点火（D103）。
  const reconnecting = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<Panel<PanelProps> | null>(null);
  const [settings, setSettings] = useState(readSettings);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 会话这一侧那一格浮层（模式与档位）：入口是顶栏那两枚小牌子（第 105 步）。
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const verbosity = settings.verbosity;
  const collapsed = settings.collapsed;
  // 输入历史在宿主那一侧的那一份共用文件里，终端界面读写的是同一个（D90、方案 5.5.6）：界面手里只是它的一个读法，-1 说的是当前那份草稿。
  const [history, setHistory] = useState<string[]>([]);
  const [walk, setWalk] = useState(-1);
  // 运行中敲进去的那几句排在界面这一侧：每份会话各排各的，取消这一轮之后停下等一次显式的继续（方案 5.2）。
  const [queues, setQueues] = useState<Record<string, { items: string[]; paused: boolean }>>({});
  const queue = queues[sessionId ?? ''] ?? { items: [] as string[], paused: false };
  const patchQueue = useCallback((own: string, next: (current: { items: string[]; paused: boolean }) => { items: string[]; paused: boolean }) => {
    setQueues((current) => ({ ...current, [own]: next(current[own] ?? { items: [], paused: false }) }));
  }, []);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // 眼前看着的那一份会话：在接会话的那一处与 `opening` 同步写下，别的那一份的答复与状态不摊到这一份的格子上。
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
  // 接会话这一动作每发起一次换一个号：只看会话编号分不出 A→B→A 里那两次接 A，旧那次的收尾会把新那次的保护解掉。
  const openRequest = useRef(0);
  // 跳到的那一行亮一小段：一屏里几十行都在，不落个记号认不出停在哪一条。
  const [flash, setFlash] = useState<number | null>(null);
  // 那一次派发是什么时候交出去的：只为算用时，键是调用 id（D94）。
  const dispatchAt = useRef(new Map<string, number>());
  // 这一条连接还在不在：null 是在，其余是那一侧报回来的说法（D93 原样带出）。
  const [link, setLink] = useState<string | null>(null);

  // 这一扇窗口打开时读那一份共用的历史一次，换一具宿主时再读一次。读不回来就当没有这一份：
  // 写那一路由宿主先读文件再合并，读失败不会把另一端写下的句子挤掉。
  useEffect(() => {
    client.call('history.read', {}, 15_000).then(
      (read) => setHistory((read as { entries: string[] }).entries),
      () => setHistory([]),
    );
  }, [client]);

  // 本轮计时：有轮在跑就一秒走一格，画面按眼前那一份会话自己那一轮的起点算秒数。
  useEffect(() => {
    if (runningIds.length === 0) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [runningIds]);

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
      // 减去的是真的进列表那几行：展示档筛掉的行不在 `visible` 里，按整页的行数减会让视口锚到别的那一行。
      setFirstIndex((current) => current - added.filter((row) => shownIn(verbosity, row)).length);
      setRows((current) => [...added, ...current]);
      setPage({ before: older.events.length === 0 ? page.before : Number(older.events[0]?.seq), hasMore: older.hasMore });
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `更早的那一页读不来：${code(error)}`)]);
    } finally {
      setOlderLoading(false);
    }
  }, [client, olderLoading, page, sessionId, verbosity]);

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

  // 配色、字号与侧栏宽度落在根元素上：那几组 CSS 变量在 `data-palette` 与 `:root` 那一格读（D90）。
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.palette = settings.palette;
    root.dataset.font = settings.font;
    root.style.setProperty('--sidebar', `${settings.sidebar}px`);
  }, [settings.font, settings.palette, settings.sidebar]);

  const patch = useCallback((part: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...part }));
  }, []);

  // 键位从界面偏好那一格读回来：整份先退回默认，再落有效的那一些；读不懂的一条条说出来（方案 6.1）。
  const [keyNotice, setKeyNotice] = useState('');
  useEffect(() => {
    const outcome = loadBindings(settings.keys);
    setKeyNotice(outcome.refused.length === 0 ? ''
      : `有 ${outcome.refused.length} 条键位落不下来，那几条按默认那一份走：${outcome.refused.join('、')}`);
  }, [settings.keys]);

  // 拖那一条分隔线改侧栏宽度：范围与设置面板里那根滑杆是同一份（D90）。
  // 指针要抓住：拖到别处（转录的滚动条、另一侧的面板）时 move 也还得送到这一处来。
  const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const startX = event.clientX;
    const startWidth = settings.sidebar;
    const target = event.currentTarget;
    try { target.setPointerCapture(event.pointerId); } catch { /* 抓不住时窗口上那三条监听照样把移动与松开送到这一处 */ }
    const move = (moveEvent: PointerEvent) => {
      patch({ sidebar: Math.min(420, Math.max(264, startWidth + moveEvent.clientX - startX)) });
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      try { target.releasePointerCapture(event.pointerId); } catch { /* 已经松开 */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }, [patch, settings.sidebar]);

  useEffect(() => {
    client.onNotification((message) => {
      if (message.notify === 'fault') {
        setRows((current) => [...current, metaRow('error', `连接上的问题：${message.code} ${message.detail ?? ''}`)]);
        return;
      }
      // 每一轮流式进来的那半截按会话各存一份：看着别的那一份时它也在长，切回来要先看见已经收到的那一段，
      // 不等那一条落进记录（方案 3.1 的后台会话继续运行、审阅 F4）。
      const owner = message.sessionId ?? '';
      const held = liveBySession.current.get(owner) ?? { text: '', reasoning: '' };
      const inView = owner === active.current;
      if (message.notify === 'delta') {
        const event = message.event as { type?: string; text?: string } | undefined;
        if (event?.type === 'text') held.text += event.text ?? '';
        else if (event?.type === 'reasoning') held.reasoning += event.text ?? '';
        else return;
        liveBySession.current.set(owner, held);
        if (inView) setLive({ ...held });
        return;
      }
      if (message.notify === 'event') {
        const record = message.event as Record_;
        // 刚落盘的那一条取代流式期间的那半截：记录是事实源（I5）。后台那一份收掉的是它自己那半截。
        if (record?.kind === 'assistant') held.text = '';
        if (record?.kind === 'reasoning') held.reasoning = '';
        if (held.text === '' && held.reasoning === '') liveBySession.current.delete(owner);
        else liveBySession.current.set(owner, held);
        if (inView) setLive({ ...held });
        if (!inView) return;
        if (record?.kind === 'assistant') {
          for (const call of record.toolCalls ?? []) dispatchAt.current.set(call.id, Date.now());
        }
        // 记录里不带逐条时间戳，用时这一格只有界面活着的那一轮量得到（D94、U50）。
        const started = record?.kind === 'tool' && record.callId !== undefined ? dispatchAt.current.get(record.callId) : undefined;
        if (started !== undefined && record?.callId !== undefined) dispatchAt.current.delete(record.callId);
        const added = projectRecord(record, started === undefined ? {} : { startedAt: started });
        if (added.length > 0) setRows((current) => [...current, ...added]);
      }
    });

    client.onRequest((message) => {
      // 提问那一发（D107）：一次请求一到四道题，答复按题目自己的编号回去，与审批各走一条链。
      if (message.method === 'question.request') {
        const asked = message.params as { sessionId?: string; projectRoot?: string; questions?: QuestionAsk['questions'] };
        const owner = asked.sessionId;
        const items = asked.questions;
        if (typeof owner !== 'string' || owner === '' || !Array.isArray(items)) return;
        const id = message.id ?? '';
        // 同一个编号不排两张卡：一张卡答一次。
        setQueries((current) => current.some((one) => one.id === id) ? current : [...current, { id, sessionId: owner, project: asked.projectRoot ?? '', questions: items }]);
        return;
      }
      // Host 朝界面发出去的请求到此只有两种：审批与提问。
      if (message.method !== 'approval.request') return;
      const params = message.params as { sessionId?: string; projectRoot?: string; tool?: string; command?: string; args?: Record<string, unknown>; reason?: string; shell?: string; executable?: string; policy?: string; policySource?: string; policyForced?: boolean };
      // 询问归那一份会话，不归眼前看着的那一份：别的那一份在等，也得让人看得见、答得掉（实现顺序第 71 步）。
      const asked = params?.sessionId;
      if (typeof asked !== 'string' || asked === '') return;
      const tool = params.tool ?? '';
      const args = params.args ?? {};
      // 画出来的那一句说的是哪个对象：命令文本、路径、目标地址，或者那一项 MCP 能力名（D67）。
      const detail = String(params.command ?? args.path ?? args.url ?? capabilityOf(tool, args));
      // 展开那一段画的是实际动的是哪一件与两段内容；其余的调用把参数交出去，命令那一类参数是空的就不给把手（方案 5.4）。
      const change = changeOf(tool, args);
      const content = changeBody(change, args);
      setAsks((current) => [...current, {
        id: message.id ?? '',
        sessionId: asked,
        project: params.projectRoot ?? '',
        tool,
        detail,
        change: change.summary,
        reason: params.reason ?? '',
        // 用哪一种语法判的、跑的是哪一个可执行文件：答的是这一条命令，看得见的该是这两样（D59）。
        backend: params.shell === undefined ? '' : `${params.shell} · ${params.executable ?? ''}`,
        // 档位、它的来源与是不是被连着拒绝压下来的：这三样跟着那一次询问一起回来，说的都是问那一份会话（审阅 C08）。
        policy: params.policy ?? '',
        policySource: params.policySource ?? '',
        policyForced: params.policyForced === true,
        content,
      }]);
    });

    // 后端进程的标准错误输出走到这里：它不是协议帧，是那一侧打印的东西。
    transport.onLog((line) => setRows((current) => [...current, metaRow('meta', `宿主输出：${line}`)]));
  }, [client, transport]);

  const refreshStatus = useCallback(async (id: string) => {
    try {
      const next = await client.call('status.get', { sessionId: id }) as Status;
      // 答复回来时人已经切到别的那一份：这一份的状态不摊到那一份的格子上。
      if (active.current !== id) return;
      setStatus(next);
    } catch (error) {
      if (active.current === id) setRows((current) => [...current, metaRow('error', `状态读不到：${code(error)}`)]);
    }
  }, [client]);

  // 询问是宿主那一侧在等的一件事，不随看着的是哪一份会话而变化：换走时不清空，否则那一条派发给谁答。
  // 只有那一轮自己收尾（跑完、被打断）或那具宿主换掉时，才收掉它名下的那些询问。
  const dropAsksOf = useCallback((id: string) => setAsks((current) => current.filter((ask) => ask.sessionId !== id)), [setAsks]);

  // 提问也按它自己那一份会话收尾（审阅 F2）：那一轮跑完、被打断、或换了宿主之后，这次问的已经没有人在等答复，
  // 卡片继续摆在能答的那一栏会做两件错事——挡住排在后面的另一份会话，还让人以为旧答案交得出去。
  // 收掉之前把题面与已经打下的字留成一条记录：那是人打过的字，不是可以无声丢掉的东西（方案 R1）。
  const dropQueriesOf = useCallback((id: string, reason: string) => {
    const left = queriesLeft.current.filter((one) => one.sessionId === id);
    if (left.length === 0) return;
    const lines = left
      .map((one) => `${questionEcho(one, questionDrafts.current.get(one.id))}（${reason}，这一次问的不再交出去）`);
    // 收尾那几句只画在那一份自己的画面上：人这时候切走了，那句话先押在这一份名下，切回来跟着那一次读落下（方案 3.1 同一条规矩）。
    if (active.current === id) setRows((current) => [...current, metaRow('meta', lines.join('\n'))]);
    else pendingEchoes.current.set(id, [...(pendingEchoes.current.get(id) ?? []), ...lines]);
    for (const one of left) questionDrafts.current.delete(one.id);
    setQueries((current) => current.filter((one) => one.sessionId !== id));
  }, [setQueries]);

  // 换会话先让 Host 那一份接上：记录不在磁盘上就是没有这份会话，`session.open` 会说清（D78）。
  // 已经打开的那一份复用状态，不重开，所以这一个动作对当前会话也是安全的。
  // 给了 `hit` 就一口气往回读到那一条进来，并把「要落到哪一条」与那些行同一批交出去：
  // 数据先变长、跳转晚一帧的话，贴在末行那一条会先把画面拉回去（U48、方案 6.2）。
  // `reclaimQueue` 只有重连那一条路给：宿主换了一具之后，那几句排着的不再留成暂停的队列，而是按先后收回草稿等一次显式的发送。
  // 正常换会话与点开一份会话仍把排着的几条恢复成暂停（方案 5.1、5.2），那一条不变。
  const openSession = useCallback(async (id: string, hit?: SearchHit, reclaimQueue = false, askedRoot?: string) => {
    opening.current = id;
    const request = ++openRequest.current;
    // 看着的是哪一份与「正在接的是哪一份」同一处定下来：状态那一次读紧跟在几次读后面，
    // 落在渲染提交之后的那一格会把这一次读判成过期，标题上的条数就停在上一份那一份。
    active.current = id;
    setSessionId(id);
    // 切回来看这一份时，它那个「刚跑完一轮」的记号就消掉（方案 3.1 的未读结果只用来指「还没看着」）。
    setUnread((current) => current.filter((item) => item !== id));
    setRows([]);
    setPage(null);
    setFirstIndex(FIRST_INDEX);
    // 切回来时先把它自己那半截流式回答摆上：这一轮还在跑的话，记录里要到那一条落盘才有全文，中间这几秒不能是空的（审阅 F4）。
    setLive({ ...(liveBySession.current.get(id) ?? { text: '', reasoning: '' }) });
    setWanted(null);
    setInputOwner(null);
    dispatchAt.current.clear();
    setReading(true);
    try {
      // 两条都带超时：那一边不回话时要显示失败那一种状态，不能一直停在「在读那份记录…」。
      // 指名了另一项目录就把它一起递过去：宿主按那一份项目环境取记录、算工具目录，身份不对时它自己报回来（方案 3.2）。
      await client.call('session.open', askedRoot === undefined || askedRoot === '' ? { sessionId: id } : { sessionId: id, projectRoot: askedRoot }, 15_000);
      // fullResults 那一格是给界面读的：溢出文件里的整段正文这才到得了画面（记录本身不动）。
      // 只取最近这一页：更早的靠「显示更早」那一格按游标往前要（方案 4.1、实现顺序第 73 步）。
      const newest = await client.call('session.read', { sessionId: id, limit: RENDER_WINDOW, fullResults: true }, 15_000) as { events: Record_[]; hasMore: boolean; header: { projectRoot?: string } | null };
      if (openRequest.current !== request) return;
      // 接上这一份时把它自己那两格摊回来：草稿是当时没发出去的那一句，排着的几条恢复成暂停（方案 5.1、5.2）。
      const root = newest.header?.projectRoot ?? '';
      setProjectRoot(root);
      const stored = readSettings();
      const storedDraft = stored.drafts[root]?.[id] ?? '';
      const restored = stored.queued[root]?.[id] ?? [];
      if (reclaimQueue && restored.length > 0) {
        // 重连之后：排着的几句按先后收回草稿，队列清空、取消暂停，界面不自动发其中任何一句。
        setDraft(mergeQueueIntoDraft(storedDraft, restored));
        patchQueue(id, () => ({ items: [], paused: false }));
      } else {
        setDraft(storedDraft);
        patchQueue(id, () => ({ items: restored, paused: restored.length > 0 }));
      }
      setInputOwner(id);
      let events = newest.events;
      let hasMore = newest.hasMore;
      while (hit !== undefined && hit.seq < Number(events[0]?.seq ?? 0) && hasMore) {
        const older = await client.call('session.read',
          { sessionId: id, before: Number(events[0]?.seq), limit: RENDER_WINDOW, fullResults: true }, 15_000) as { events: Record_[]; hasMore: boolean };
        // 人在这几页读回来的时候切走了：这一份答复过期，不落到新的画面上（方案 6.2）。
        if (openRequest.current !== request) return;
        if (older.events.length === 0) { hasMore = false; break; }
        events = [...older.events, ...events];
        hasMore = older.hasMore;
      }
      // 那一份会话不在画面时收掉的提问留下的那一句，跟着这一次读一起落下：那一轮的事只说得上它自己那一份画面。
      const kept = pendingEchoes.current.get(id) ?? [];
      pendingEchoes.current.delete(id);
      setRows([...events.flatMap((record) => projectRecord(record)), ...kept.map((text) => metaRow('meta', text))]);
      setPage({ before: Number(events[0]?.seq ?? 1), hasMore });
      // 上一次读到的位置还在手里这一页之内就落回去；落不回就停在末尾，不替他改展示档，也不往前多读页。
      const anchor = anchors.current.get(id);
      const back = anchor !== undefined && anchor > Number(events[0]?.seq) && anchor < Number(events.at(-1)?.seq)
        ? { sessionId: id, seq: anchor, kind: 'anchor' }
        : null;
      setWanted(hit ?? back);
    } catch (error) {
      // 过期那一次的失败不说在新那一次的画面上：那一份会话可能已经接上了，报的是别处的旧账。
      if (openRequest.current === request) setRows((current) => [...current, metaRow('error', `那份会话接不上：${code(error)}`)]);
    } finally {
      // 只有还是这一次在接的时候才收输入保护：旧那一次的收尾把新那一次的锁解开，人就会在答复还没回来时发出去。
      if (openRequest.current === request) setReading(false);
    }
    if (openRequest.current !== request) return;
    void refreshStatus(id);
  }, [client, refreshStatus]);

  const newSession = useCallback(async (root?: string) => {
    try {
      // 指名了哪一具工作区就在哪一个项目里建；没指名时先看眼前这一份会话在哪一项目录，再退到那份登记里的默认那一具，
      // 登记里没有就问壳要系统文档目录下那一具并登记成默认。来源那一格按这几档说清是谁选的（方案 3.2、5.5.3）。
      const named = root === undefined || root === '' ? undefined : root;
      const current = projectRoot === '' ? undefined : projectRoot;
      let landing: string | undefined;
      let refused: string | undefined;
      if (named === undefined && current === undefined) {
        landing = await defaultWorkspaceOf(client);
        if (landing === undefined && transport.defaultWorkspace !== undefined) {
          const fromShell = await registerShellWorkspace(transport.defaultWorkspace, client);
          landing = fromShell.directory;
          refused = fromShell.failed;
        }
      }
      // 壳在的那一侧不拿宿主继承的那个进程目录当工作区：几格都空着说的是「先选一具工作区」，不是悄悄开一份。
      // 载体交不出这一格时（浏览器里开发）没有壳可问，仍由宿主用它自己那一份项目环境。
      if (named === undefined && current === undefined && landing === undefined && transport.defaultWorkspace !== undefined) {
        setRows((rows) => [...rows, metaRow('meta', `还没有可用的工作区${refused === undefined ? '' : `：${refused}`}。在左侧栏「另一个项目的目录」那一格写一处，或在想用的那一组上按「新建」。`)]);
        return;
      }
      const params = createCallOf(named, current, landing);
      const asked = params.projectRoot;
      const created = await client.call('session.create', params) as { sessionId: string };
      // 新建那一份也走接会话那一条路：只有那一次读把记录头部的项目根带回来，草稿与队列才知道该存到哪一格。
      // 指名了哪一项目录就带着它去接：不带的话宿主按默认那一份项目环境找记录，另一项目录里刚建好的那一份就报 `session_not_found`（方案 3.2）。
      void openSession(created.sessionId, undefined, false, asked);
      // 这一扇窗口自己刚造出来的那一份要马上在左侧栏里看得见，不该让人再去按一次「刷新」（方案 4.2 的会话列表）。
      setSessionsRevision((current) => current + 1);
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `会话建不起来：${code(error)}`)]);
    }
  }, [client, openSession, projectRoot, transport]);

  useEffect(() => {
    // 只在手里还没有会话时自动开第一份：`newSession` 的身份跟着 `projectRoot` 变，少了这一道判断，
    // 接上另一项目录里的会话会把这一格改掉，这个 effect 就跟着又建一份并跳过去（方案 3.2）。
    if (sessionId !== null) return;
    void newSession();
  }, [sessionId, newSession]);

  // 查找命中那一条交给接会话那一个动作：读到位与落笔在同一批里，跳转那一处只认这一份会话的第几条（方案 4.2）。
  const openHit = useCallback((hit: SearchHit, root?: string) => void openSession(hit.sessionId, hit, false, root), [openSession]);

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
  // 接回来时这一份会话排着的几句交回草稿（`reclaimQueue`），界面不自动发；人为取消那一路不受这里影响。
  const reconnect = useCallback(async () => {
    reconnecting.current = true;
    client.discard('host_restarted');
    setAsks([]);
    // 换了一具宿主，旧的那一发请求身份就作废了：题面与已经打下的字各自留成一条可读的记录，不自动发给新的宿主（方案 4.4、审阅 F2）。
    for (const owner of new Set(queriesLeft.current.map((one) => one.sessionId))) dropQueriesOf(owner, '宿主换了一具');
    setRunningIds([]);
    try {
      try {
        await transport.restart?.();
      } catch (error) {
        setRows((current) => [...current, metaRow('error', `后端进程起不来：${code(error)}`)]);
        return;
      }
      if (sessionId !== null) {
        // 刚被硬杀的那一具宿主把写入租约留在原地，最多十秒过期（`SESSION_LOCK_STALE_MS` 那一格）：重连常常正好落在这段里。
        // 等它过期再接这一份，最多十二秒；等不到就交给下面那一次读去说「那份会话接不上」，人再按一次重连。
        const deadline = Date.now() + 12_000;
        for (;;) {
          try {
            await client.call('session.open', projectRoot === '' ? { sessionId } : { sessionId, projectRoot }, 15_000);
            break;
          } catch (error) {
            if (code(error) !== 'session_locked' || Date.now() >= deadline) break;
            await new Promise((done) => setTimeout(done, 1_000));
          }
        }
        await openSession(sessionId, undefined, true);
      }
    } finally {
      // 这一格必须在每一条路上都清掉：留着会让之后每一次重连都点在「还在重连」上，队列也永远不点火。
      reconnecting.current = false;
    }
  }, [client, dropQueriesOf, openSession, projectRoot, sessionId, setAsks, setRunningIds, transport]);

  const readBack = useCallback(async () => {
    if (sessionId === null) return;
    await openSession(sessionId);
  }, [sessionId, openSession]);

  // 发一句给哪一份会话由 `own` 说定，不读屏幕上的那一份：跑着的这一轮从开始到收尾都只说得上它自己那一份。
  // 收尾那几句（本轮结束、被打断、放回草稿、状态）只画在这一轮自己的画面上：人这时候切走了，眼前那一份不替另一份记一句。
  // 回到那一份时读回来的是记录里有的那几行：跑完的那一轮有 `turn` 事件，画成「这一轮完整结束」；被打断的那一轮没有，
  // 它留下的是这一轮自己的事件（含那一次被取消的提问），界面不替记录补一句它没写过的话（I5）。
  const submit = useCallback(async (text: string, own = sessionId) => {
    if (text === '' || own === null) return;
    const inView = () => active.current === own;
    // 这一份会话自己跑着的时候回车不丢话：那一句排在界面这一侧，它自己那一轮结束后按先后发出（方案 5.2、D81 边界二：不进记录）。
    if (runningIds.includes(own)) {
      if (inView()) { setDraft(''); setWalk(-1); }
      patchQueue(own, (current) => ({ ...current, items: [...current.items, text] }));
      return;
    }
    if (inView()) { setDraft(''); setWalk(-1); }
    // 发出去的那一句进那一份共用的历史：宿主读文件、把这一句挪到最前、写回来，界面采用它交回的那一份清单。
    // 写不进去时按眼前这一份继续走（这一句在这一扇窗口里还翻得回来），发送本身不等这一格（方案 5.5.6）。
    void client.call('history.append', { text }, 15_000).then(
      (written) => setHistory((written as { entries: string[] }).entries),
      () => setHistory((current) => [text, ...current.filter((item) => item !== text)]),
    );
    roundStart.current.set(own, Date.now());
    setTick(Date.now());
    setRunningIds((current) => [...current, own]);
    try {
      const result = await client.call('run.start', { sessionId: own, input: text }) as { iterations: number; modelCalls: number; completedBy?: string };
      if (inView()) setRows((current) => [...current, metaRow('meta', `这一轮结束：跑了 ${result.iterations} 次迭代、${result.modelCalls} 次模型调用${result.completedBy === undefined ? '' : `，最后由 ${result.completedBy} 收尾`}`)]);
    } catch (error) {
      const stopped = code(error);
      // 打断落在还在跑的模型调用上时端点那一头交回 `provider_cancelled`，落在两组调用之间才是 `loop_cancelled`，
      // 落在等一个人回答的那一次提问上才是 `ask_user_cancelled`：人要读的是同一句——这一轮是他停下来的（方案 5.2、D107）。
      const cancelled = stopped === 'loop_cancelled' || stopped === 'provider_cancelled' || stopped === 'ask_user_cancelled';
      // 没被宿主受理的那一句不丢：连接上的那几种失败说明这一句在记录里根本没有落过，把它放回草稿等一次显式的发送
      // （方案 5.1「未受理失败恢复文本」）。受理过之后才失败的那一种不在此列——那句话已经在记录里了。
      if (inView() && (stopped === 'host_unanswered' || stopped === 'host_closed' || stopped === 'host_restarted')) setDraft((current) => mergeQueueIntoDraft(current, [text]));
      if (inView()) setRows((current) => [...current, metaRow(cancelled ? 'meta' : 'error', cancelled ? '这一轮已被打断' : `这一轮停住：${stopped}`)]);
    } finally {
      setRunningIds((current) => current.filter((id) => id !== own));
      roundStart.current.delete(own);
      // 这一轮收尾了：它名下那些没答的询问由宿主按「不允许」结了，界面上不再留着让人去答——留着的原因要说一句（方案 5.4）。
      const left = asksLeft.current.filter((ask) => ask.sessionId === own).length;
      if (left > 0 && inView()) {
        setRows((current) => [...current, metaRow('meta', `这一轮收尾时还有 ${left} 条没答的询问：它们按不允许结掉，不再摆在能答的那一栏里`)]);
      }
      dropAsksOf(own);
      // 那一份会话的提问跟着同一轮收尾（审阅 F2）：旧的宿主不再等答复，那张卡继续摆在能答的那一栏
      // 会挡住排在后面的另一份会话，也让人以为旧答案还交得出去。
      dropQueriesOf(own, '这一轮已经收尾');
      // 这一轮收尾了：它名下那半截流式片段不再有内容要补（最后那一条由记录说话），这一格不留着（审阅 F4）。
      liveBySession.current.delete(own);
      // 只有它自己那一份会话的这一轮结束才让它发下一条；别的会话的轮次收尾不替它发（方案 5.2）。
      allowSend.current.add(own);
      // 收尾时人不在这一份的画面上：给那一份会话挂一个「刚跑完一轮」的记号，切过去就消（方案 3.1 的未读结果）。
      if (!inView()) setUnread((current) => [...new Set([...current, own])]);
      void refreshStatus(own);
    }
  }, [client, dropAsksOf, dropQueriesOf, patchQueue, refreshStatus, runningIds, sessionId]);

  // 本轮收尾后把排着的第一条发出去：一次只发一条。暂停着就一条也不发——那几句是人在跑着的时候敲进来的，
  // 他按下的是取消，剩下怎么走要他再说一次（方案 5.2）。断着连接与重连那一段也不算「本轮收尾」：
  // 那一句会发给已经不在了的那一具宿主（D103）。
  // 「该发的那一份」对不上眼前这一份时什么都不发：后台那一轮的完成不能启动另一份会话的输入（方案 5.2 那句），
  // 那几句排在后面的要人切回去、或按下「继续发」才走。
  useEffect(() => {
    // 与 `send` 同一条门槛：身份与草稿归属还没跟上这一份之前，排着的第一条也不发出去（审阅 F5）。
    if (reading || inputOwner !== sessionId) return;
    if (running || link !== null || reconnecting.current || sessionId === null) return;
    if (!allowSend.current.has(sessionId)) return;
    const own = queues[sessionId];
    if (own === undefined || own.paused || own.items.length === 0) return;
    const [next, ...rest] = own.items;
    allowSend.current.delete(sessionId);
    patchQueue(sessionId, () => ({ items: rest, paused: false }));
    void submit(next, sessionId);
  }, [inputOwner, patchQueue, queues, reading, running, sessionId, submit]);

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

  // 接一份会话的那一段里不发出去任何东西：`sessionId` 已经换了而草稿与归属还是上一份的，
  // 这时候按回车或按发送那一枚会把上一句按新的那一份身份落进记录（审阅 F5）。
  // 这一段里输入坞同时是只读的（下面 `readOnly` 那一格），人新打的字不会被随后恢复草稿那一步盖掉。
  const send = useCallback(async () => {
    if (reading || inputOwner !== sessionId) return;
    await submit(draft.trim());
  }, [draft, inputOwner, reading, sessionId, submit]);

  // 取消哪一份会话的那一轮由 `own` 说定：默认是眼前这一份，另一份会话的提问卡取消的是它自己那一份（审阅 F1）。
  const cancel = useCallback(async (own = sessionId) => {
    if (own === null) return;
    // 停下的是那一份会话自己那一轮：另一份会话在跑不由这一枚按钮管（顶栏那枚牌子说出有几份在跑）。
    // 按下取消就是「剩下的别自己走」：那几条留在那一份会话名下，等一次显式的继续（方案 5.2）。
    if ((queues[own]?.items.length ?? 0) > 0) patchQueue(own, (current) => ({ ...current, paused: true }));
    try {
      await client.call('run.cancel', { sessionId: own });
    } catch (error) {
      // 这一句说的是那一份会话的取消，画在它的画面里：人这时候切走了，这一句等切回来由记录补。
      if (active.current === own) setRows((current) => [...current, metaRow('meta', `取消没生效：${code(error)}`)]);
    }
  }, [client, patchQueue, queues, sessionId]);

  // 等手停下 160 毫秒问一次；答回来时那一段已经改了就把那一次丢掉。传输那一层没有中途取消，
  // 所以 5.3 那一条「慢请求可取消」在这儿做到的是不落到画面上。
  useEffect(() => {
    const token = mentionToken(draft, caret);
    if (token === null) { setMention(null); mentionAsked.current = NO_TOKEN; return; }
    mentionWanted.current = token;
    if (hiddenMention === token.text) { mentionAsked.current = NO_TOKEN; return; }
    // 「上一次问的是哪一段」放在 ref 而不是 state：写进 state 会让本条 effect 重跑，
    // 那一次重跑先把已经排好的那一下问撤销掉，接着又因为这一段没变而不再重问，画面就停在等那一下上。
    const asked = mentionAsked.current;
    if (asked.start === token.start && asked.text === token.text) return;
    // 换了一个词就把手里那几条旧的候选放下：清单留着，Enter 就会把人没选过的那一条插进去。
    mentionAsked.current = token;
    setMention({ ...token, paths: [], chosen: 0, stopped: 'pending', root: projectRoot });
    const timer = setTimeout(() => {
      void (async () => {
        const listed = await client.call('paths.list', { projectRoot, query: token.text, limit: 8 }, 8_000)
          .then((answer) => {
            const got = answer as { projectRoot: string; paths: string[]; stopped: string };
            return { paths: got.paths, stopped: got.stopped, root: got.projectRoot, failed: undefined as string | undefined };
          })
          .catch((error) => ({ paths: [] as string[], stopped: 'error', root: projectRoot, failed: code(error) }));
        const now = mentionWanted.current;
        if (now.start !== token.start || now.text !== token.text) return;
        setMention({ ...token, paths: listed.paths, chosen: 0, stopped: listed.stopped, root: listed.root, failed: listed.failed });
      })();
    }, 160);
    return () => clearTimeout(timer);
  }, [caret, client, draft, hiddenMention, projectRoot]);

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
        ? `模式换成 ${result.mode}，现在生效`
        : `模式 ${result.pending} 排在后面，这一轮结束时换上`)]);
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `模式换不了：${code(error)}`)]);
    }
    void refreshStatus(sessionId);
  }, [client, refreshStatus, sessionId]);

  // 换审批档位走 `policy.set`（交付四）：这一份会话临时改 ask 或 auto，`null` 退回配置默认那一档。
  const setPolicy = useCallback(async (mode: 'ask' | 'auto' | null) => {
    if (sessionId === null) return;
    try {
      const result = await client.call('policy.set', { sessionId, mode }) as { policy: string; policySource: string };
      setRows((current) => [...current, metaRow('meta', mode === null
        ? `审批档位退回配置默认，现在生效的是 ${result.policy}`
        : `审批档位换成 ${result.policy}，只对这一份会话有效`)]);
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `审批档位换不了：${code(error)}`)]);
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
    { id: 'session.new', title: '新建一份会话', note: 'session.create', run: () => void newSession() },
    { id: 'session.read', title: '读回这一份会话的记录', note: 'session.read', run: () => void readBack() },
    { id: 'session.branch', title: '把这一份会话分支一份新的', note: 'session.branch：复制到此刻记录落到哪儿为止', run: () => void branchFrom() },
    { id: 'run.cancel', title: '取消这一轮', note: 'run.cancel', run: () => void cancel() },
    { id: 'session.compact', title: '手动压缩上下文', note: 'session.compact', run: () => void compact() },
    { id: 'settings.open', title: '打开设置', note: '外观、模型与端点、审批规则、连接、键位', run: () => setSettingsOpen(true) },
    { id: 'rail.toggle', title: collapsed ? '展开左侧栏' : '收起左侧栏', note: formatKeys(CURRENT['sidebar']), run: () => patch({ collapsed: !collapsed }) },
    { id: 'answer.copy', title: '复制最后那条回答', note: formatKeys(CURRENT['copy-answer']), run: copyLastAnswer },
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
    // 答完把焦点从那一枚按钮上移开：焦点还停在按钮上时，下一次 Enter 会再按一次同一枚按钮——那是误批准的一条路（方案 5.4）。
    // 移开之后交给输入坞：只用键盘的人答完接着说话，焦点丢给页面就要从页头重新 Tab 过去（第 94 步量到 42 次）。
    (document.activeElement as HTMLElement | null)?.blur();
    composerRef.current?.focus();
  }, [asks, client, sessionId]);

  // 提问只交一次答复：交出去就把这张卡收掉，之后再按没有对象可答（一次请求一次答复，D107）。
  const answerQuestion = useCallback((answers: { id: string; selected: string[]; custom?: string }[]) => {
    const [head, ...rest] = queries;
    if (head === undefined) return;
    setQueries(rest);
    questionDrafts.current.delete(head.id);
    if (head.sessionId === sessionId) {
      setRows((current) => [...current, metaRow('meta', `已答 ${head.questions.length} 道题里的 ${answers.length} 道，其余按「没有回答」记下`)]);
    }
    client.reply(head.id, { answers });
    // 与审批那两枚一样：答完把焦点从按钮上移开，免得下一次 Enter 又按一次同一枚。
    (document.activeElement as HTMLElement | null)?.blur();
    composerRef.current?.focus();
  }, [client, queries, sessionId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 输入法正在拼的那一段里，Esc 属于取消候选词，Enter 属于选中候选词：这一路都不能替人收面板或打断这一轮（方案 5.1、5.4）。
      if (isComposing(event)) return;
      // 设置那一栏正在录一记新键：这一记按键属于「换成什么」，窗口这一层不接（方案 6.1）。
      if (isCapturing()) return;
      // 按键落的是哪一个动作读这一份表，界面上说出来的一串字也从同一处取（方案 6.1）。
      const action = actionOf(event, '窗口');
      if (action !== null && action !== 'interrupt') {
        event.preventDefault();
        if (action === 'palette') setPaletteOpen((open) => !open);
        else if (action === 'sidebar') patch({ collapsed: !collapsed });
        else copyLastAnswer();
        return;
      }
      // 收层那一条顺序排在打断这一轮之前：面板、右侧抽屉，都收完了才轮到取消。
      if (specOf(event) !== CURRENT['interrupt']) return;
      // 那一层浮层（命令面板、这一份会话、设置、功能菜单）的 Esc 归 radix 收：它收层时把这一记键标成已处理。
      // 状态那一格在这里靠不住——这一记按键是离散事件，radix 收到 React 里先改完状态并重画，键才冒到 document，
      // 这一条读到的已经是收层之后的那一份。按「这记键有没有人接过」判，才只收一层。
      if (event.defaultPrevented) return;
      if (panel !== null) setPanel(null);
      else if (running) void cancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cancel, collapsed, copyLastAnswer, panel, patch, running]);

  // 虚拟视口的两件外壳（U48、方案 6.2）：每一条都要占住转录那一条 74 字的居中列，所以 `Item` 自己包一层。
  // 空记录那一句不由视口画：这一版的视口没有空状态那个槽位，那一处写在渲染里的视口外面。
  // 身份用 `useMemo` 稳住：每次渲染都换一个新组件会让视口把挂着的行重建一遍。
  const viewport = useMemo(() => ({
    // 换外壳要连着 Virtuoso 读尺寸用的那几格 `data-*` 一起递出去，只转 children 与 style 会让它量不到行高（U48）。
    Item: ({ children, style, ...rest }: ItemProps<Row>) => <div {...rest} style={style} className="stream-row">{children}</div>,
    Header: () => <div className="stream-band">
      {page?.hasMore === true && <button type="button" className="earlier" disabled={olderLoading} onClick={() => void showEarlier()}>
        {olderLoading ? '在读更早的一页…' : '显示更早的一页'}
      </button>}
    </div>,
  }), [olderLoading, page, showEarlier]);
  // 展示档没放进来那几类行不进列表：虚拟视口要量每一行的高度，藏着不画的行留在列表里只会量到零（D90、U48）。
  const shown = useMemo(() => rows.filter((row) => shownIn(verbosity, row)), [rows, verbosity]);
  // 流式那半截排在已落盘的那些行之后：它是这一轮的末尾，画到开头去就把因果倒过来了。
  // 这一份数组交给视口当数据：身份必须稳住（只在真有变化时才换），否则每渲染一个新数组会让视口
  // 一直当它变了，短记录上那一串重排会连成死循环（第 105 步在真端点上撞到过两次）。
  const visible = useMemo(() => (live.reasoning === '' && live.text === '' ? shown : [
    ...shown,
    ...(live.reasoning === '' || !shownIn(verbosity, LIVE_REASONING) ? [] : [{ ...LIVE_REASONING, text: live.reasoning }]),
    ...(live.text === '' || !shownIn(verbosity, LIVE_ANSWER) ? [] : [{ ...LIVE_ANSWER, text: live.text }]),
  ]), [shown, live.reasoning, live.text, verbosity]);

  // 记住这一份会话读到哪儿：画面最上面那一行的事件序号，切回来时按它落回去（方案 6.2）。
  // 身份要稳住：每次渲染都换一个新函数会让视口重新订阅一次，短记录上那几次重排会连成一串（第 105 步）。
  const onRangeChanged = useCallback(({ startIndex }: { startIndex: number }) => {
    const row = visible[startIndex - firstIndex];
    if (row?.seq !== undefined && sessionId !== null) anchors.current.set(sessionId, row.seq);
  }, [visible, firstIndex, sessionId]);

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
    setRows((current) => [...current, metaRow('meta', `第 ${wanted.seq} 条不在这份转录里：${wanted.kind === 'label' ? '那一条说的是这一份会话自己的名字，画在标题与左侧列表上' : '它不在这一份记录读得到的那几类里'}`)]);
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
  const initialIndex = useMemo(() => (jumpAt < 0 ? undefined : { index: jumpAt, align: 'start' as const }), [jumpAt]);

  const panelProps: PanelProps = {
    client,
    status,
    sessionId,
    running,
    othersRunning,
    runningIds,
    unread,
    seconds,
    waiting: client.waiting(),
    counts: client.counts(),
    openSession: (id: string, root?: string) => void openSession(id, undefined, false, root),
    openHit,
    projects: settings.projects,
    onProjects: (roots: string[]) => patch({ projects: roots }),
    projectRoot,
    createIn: (root?: string) => void newSession(root),
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
        {/* 这一枚菜单交给 radix：打开、收起、方向键走到哪一条、焦点交回都由它管，这里只说有哪些功能项（方案 4.2）。 */}
        <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <button className="entry" type="button"><Icon name="grid" size={15} /><span>功能</span></button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu" side="top" align="start" sideOffset={4} onEscapeKeyDown={keepEscape}>
              {registry.list('rail.menu').map((item) => <DropdownMenu.Item key={item.id} onSelect={() => setPanel(item)}>
                {item.title}{item.pending === true && <span className="menu-tag">待实现</span>}
              </DropdownMenu.Item>)}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </aside>
    <div className="splitter" role="separator" aria-orientation="vertical" aria-label="侧栏宽度" onPointerDown={startDrag} />

    <main className="center">
      <header className="topbar">
        <div className="title">
          <strong id="session-title">{sessionId === null ? '没有会话' : `会话 ${sessionId.slice(0, 8)}`}</strong>
          <span className="muted" id="session-note">{status === null ? '还没有会话：新建一份，或者从左侧栏挑一份' : `记录 ${status.eventCount} 条`}</span>
        </div>
        {/* 这一份会话那几格：那两枚胶囊是浮层的入口，那一横排是它的锚；点开、点外面收起、焦点交回都归 radix（方案 4.2）。 */}
        <Popover.Root open={sessionMenuOpen} onOpenChange={setSessionMenuOpen}>
          <Popover.Anchor className="pills">
            {registry.list('header.status').map((item) => <span key={item.id}>{item.view(panelProps)}</span>)}
          </Popover.Anchor>
          <SessionMenu status={status} onSetMode={(name) => void setMode(name)} onSetPolicy={(mode) => void setPolicy(mode)} />
        </Popover.Root>
        <button className="icon-button" type="button" title={`命令面板（${formatKeys(CURRENT['palette'])}）`} aria-label="命令面板" onClick={() => setPaletteOpen(true)}><Icon name="search" size={15} /></button>
      </header>

      {/* 转录只挂视口里那几十行：读回来的那一页全在数据里，画出来的由视口决定（U48、方案 6.2）。
          记录里一行都没有时不挂视口：这一版的视口没有空状态那个槽位，那一句写在视口外面，否则人面对的是一片空白。
          展示档筛掉全部那一种不算空记录，视口照旧挂着，「显示更早」那一格才留在画面上（D90）。 */}
      <div className="conversation" aria-live="polite">
        {rows.length === 0 ? <div className="stream-band">{reading
          ? <p className="placeholder"><Icon name="clock" size={14} /> 在读这一份会话的记录…</p>
          : <p className="placeholder"><Icon name="spark" size={14} /> 这一份会话还没有一轮。在下方写一句要模型做的事，按 {formatKeys(CURRENT['send'])} 就开始。</p>}</div> : <Virtuoso
          key={`stream-${stamp}`}
          ref={list}
          style={{ height: '100%' }}
          data={visible}
          firstItemIndex={firstIndex}
          initialTopMostItemIndex={initialIndex}
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
          // 只在真的翻过去时才改这一格：视口在「到底」附近来回报同一件事实时，
          // 一次 setState 会让视口重排，重排又报一次——记录短得装不满一屏时这一条会转成死循环（第 105 步在真端点上撞到）。
          atBottomStateChange={(atBottom) => setPinned((current) => (current === atBottom ? current : atBottom))}
          rangeChanged={onRangeChanged}
          increaseViewportBy={VIEWPORT_INCREASE}
          components={viewport}
        />}
        {/* 离开末行时浮出来的那一枚：挂在转录这一格外面要占一段高度，出现与收掉时转录跟着换高，
            所以画在转录里面、绝对定位。 */}
        {!pinned && <button className="jump-latest" type="button" onClick={jumpToLatest}>回到最新</button>}
      </div>

      {queries.length > 0 && <QuestionCard
        key={queries[0].id}
        ask={queries[0]}
        queued={queries.length - 1}
        active={sessionId}
        onOpen={(id: string) => void openSession(id)}
        onSubmit={answerQuestion}
        // 取消的是这一张卡自己那一份会话的那一轮：页面切到另一份正在跑的会话时，这一枚按钮不能替那一份停下来（审阅 F1）。
        onCancel={() => void cancel(queries[0].sessionId)}
        onDraft={keepQuestionDraft}
      />}

      {asks.length > 0 && <ApprovalCard
        ask={asks[0]}
        queued={asks.length - 1}
        verbosity={verbosity}
        active={sessionId}
        onOpen={(id: string) => void openSession(id)}
        onAnswer={answer}
      />}

      {link !== null && <div className="banner" role="alert">
        <Icon name="warn" size={15} />
        <strong>这一条连接不在了</strong>
        <code>{link}</code>
        <span>重连会换一具后端进程。没答复的那些请求按 <code>host_restarted</code> 收尾，还没答的询问作废，这一份会话接回来。</span>
        <button type="button" onClick={() => void reconnect()}>重连</button>
      </div>}

      <footer className="composer">
        {queue.items.length === 0 ? null : (
          <div className="queue">
            <div className="queue-head">
              <span className="mini">排着 {queue.items.length} 条 · {queue.paused
                ? '暂停中：这一轮是你停下来的，剩下的不自己发'
                : running
                  ? '这一轮结束后按先后一条一条发出去'
                  : '这一份现在空闲：这一句不自己发，按「收回」拿回草稿再发'}</span>
              <button type="button" className="mini chip" title={queue.paused ? '接着把排着的发出去' : '先停下，排着的几条都不发'}
                onClick={() => {
                  if (sessionId === null) return;
                  // 按下「继续发」是这一份会话自己要走了：只有这条路和它自己那一轮结束能让它发下一条（方案 5.2）。
                  if (queue.paused) allowSend.current.add(sessionId);
                  patchQueue(sessionId, (current) => ({ ...current, paused: !current.paused }));
                }}>
                {queue.paused ? '继续发' : '暂停发'}
              </button>
              <button type="button" className="mini chip" disabled={draft !== ''}
                title={draft === '' ? '把这几条都收回草稿，中间空一行分开' : '草稿上还有字：先把那一句发出去或排起来，这里不把两句拼在一起'}
                onClick={() => recoverQueueItem(0, true)}>全部收回</button>
            </div>
            {queue.items.map((item, index) => (
              <div className="queue-item" key={`${index}:${item}`}>
                <span className="queue-text">{item}</span>
                <button type="button" className="mini chip" disabled={draft !== ''}
                  title={draft === '' ? '收回草稿，队列少一条' : '草稿上还有字：先把那一句发出去或排起来，这里不把两句拼在一起'}
                  onClick={() => recoverQueueItem(index, false)}>收回</button>
              </div>
            ))}
          </div>
        )}
        {mention === null ? null : (
          <div className="queue" role="listbox" aria-label="项目里的文件">
            <span className="mini">项目 {mention.root === '' ? '读不出目录' : mention.root} · 这些文件名里含「{mention.text}」</span>
            {mention.paths.length === 0 ? (
              <span className="mini">{mention.stopped === 'error'
                ? `这个项目列不出文件：${mention.failed}`
                : mention.stopped === 'pending'
                  ? '在列这个项目的文件…'
                  : mention.stopped === 'budget'
                    ? `前面那些文件里没有文件名含「${mention.text}」的，更深的目录没翻到：把字写得更具体一些`
                    : `这个项目里没有文件名含「${mention.text}」的文件`}</span>
            ) : mention.paths.map((path, index) => (
              <div className="queue-item" key={path} role="option" aria-selected={index === mention.chosen}>
                <span className="queue-text">{path}</span>
                <button type="button" className="mini chip" onClick={() => pickMention(path)}>插入</button>
              </div>
            ))}
            {mention.paths.length > 0 && mention.stopped === 'budget'
              && <span className="mini">只翻了前面那些文件，更深的目录没看到：把字写得更具体一些</span>}
            {mention.paths.length > 0 && mention.stopped === 'unreadable'
              && <span className="mini">有一层目录读不了，这份清单不一定全</span>}
            {mention.paths.length > 0 && <span className="mini">{`按 ${formatKeys(CURRENT['pick-candidate'])} 或 ${formatKeys(CURRENT['complete-candidate'])} 选中那一条 · ${formatKeys(CURRENT['candidate-older'])}${formatKeys(CURRENT['candidate-newer'])} 换一条 · ${formatKeys(CURRENT['hide-candidate'])} 收起这一份清单`}</span>}
          </div>
        )}
        <textarea
          className="composer-input"
          ref={composerRef}
          rows={3}
          value={draft}
          // 接一份会话的那一段里不接新字：这一段屏幕上还是上一份的草稿，敲进去的会落在错的归属上（方案 5.1、审阅 F5）。
          readOnly={reading}
          placeholder={`要模型做的事。按 ${formatKeys(CURRENT['send'])} 发送；正在跑的时候这一句排到后面；${formatKeys(CURRENT['newline'])} 换行；空草稿上按 ${formatKeys(CURRENT['history-older'])}${formatKeys(CURRENT['history-newer'])} 翻本机输入历史；打 @ 引一份项目里的文件。`}
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
            // 清单开着时这几记按键归清单那一层：Enter 与 Tab 是选中那一条，不是发送（方案 5.3「选中候选不能触发发送」）。
            if (mention !== null) {
              const candidate = actionOf(event, '候选清单');
              if (candidate === 'hide-candidate') {
                setHiddenMention(mention.text);
                setMention(null);
                return;
              }
              // 那一次查询还没回来时 Enter 与 Tab 什么都不做：既不选一条旧的候选，也不把这一句发出去。
              if (mention.stopped === 'pending' && (candidate === 'pick-candidate' || candidate === 'complete-candidate')) {
                event.preventDefault();
                return;
              }
              // 选中与换一条都要手里真的有几条：一条都没有时这两记键落回输入坞那一份，Enter 照旧发这一句。
              if (candidate !== null && mention.paths.length > 0) {
                event.preventDefault();
                if (candidate === 'pick-candidate' || candidate === 'complete-candidate') {
                  pickMention(mention.paths[Math.min(mention.chosen, mention.paths.length - 1)]);
                  return;
                }
                const step = candidate === 'candidate-older' ? -1 : 1;
                setMention({ ...mention, chosen: (mention.chosen + step + mention.paths.length) % mention.paths.length });
                return;
              }
            }
            const typed = actionOf(event, '输入坞');
            if (typed === 'send' || typed === 'send-alt') {
              event.preventDefault();
              void send();
              return;
            }
            // 只在空草稿或已经在历史里走的时候接这两个键：否则它们该移动光标。
            if (typed !== 'history-older' && typed !== 'history-newer') return;
            if (draft !== '' && walk < 0) return;
            if (history.length === 0) return;
            event.preventDefault();
            const next = typed === 'history-older' ? Math.min(walk + 1, history.length - 1) : walk - 1;
            setWalk(next);
            setDraft(next < 0 ? '' : history[Math.max(next, 0)] ?? '');
          }}
        />
        <div className="composer-bar">
          <button type="button" className="mini chip" title="打开这一份会话的设置：模式、审批档位、拒绝计数" onClick={() => setSessionMenuOpen((open) => !open)}>
            模式 <b>{status?.mode ?? '没装'}</b>
          </button>
          <span className="bar-spacer" />
          <button className="icon-button" type="button" title="读回这一份记录" aria-label="读回记录" onClick={() => void readBack()}><Icon name="refresh" size={15} /></button>
          <button className="icon-button" type="button" title={`复制最后那条回答（${formatKeys(CURRENT['copy-answer'])}）`} aria-label="复制回答" onClick={copyLastAnswer}><Icon name="copy" size={15} /></button>
          <button className="icon-button" type="button" title={`取消这一轮（${formatKeys(CURRENT['interrupt'])}）`} aria-label="取消本轮" disabled={!running} onClick={() => void cancel()}><Icon name="stop" size={15} /></button>
          <button className="send" type="button" title={running ? `排到后面（${formatKeys(CURRENT['send'])}，这一轮结束后发出）` : `发送（${formatKeys(CURRENT['send'])}）`} aria-label="发送" disabled={sessionId === null || reading} onClick={() => void send()}><Icon name="send" size={17} /></button>
        </div>
      </footer>
      <div className="statusbar">
        <span>管道 · 发出 {panelProps.counts.sent} 条 · 收到 {panelProps.counts.received} 条</span>
        <span>{running ? `正在跑 ${seconds} 秒` : othersRunning > 0 ? `这一份空闲：另一份在跑 ${othersRunning} 份` : '空闲'}</span>
        {/* 页脚只说得出「哪一份会话」，完整的编号留在设置里「连接」那一栏（那里是诊断读数该在的地方，审阅 C14）。 */}
        <span title={sessionId ?? undefined}>{sessionId === null ? '没有会话' : `会话 ${sessionId.slice(0, 8)}`}</span>
      </div>
    </main>

    {panel !== null && <aside className="dock">
      <div className="dock-head">
        <strong className="dock-title">{panel.title}{panel.pending === true && <span className="menu-tag">待实现</span>}</strong>
        <button type="button" className="icon-button" aria-label="关闭面板" onClick={() => setPanel(null)}><Icon name="close" size={15} /></button>
      </div>
      <div className="dock-body">{panel.view(panelProps)}</div>
    </aside>}

    {/* 面板收起后把焦点交回输入坞：面板自己那一个过滤框带着 `autoFocus`，它收掉之后没人可交，落在页面上就得从页头重新 Tab 过去。 */}
    {paletteOpen && <Palette commands={commands} onClose={() => { setPaletteOpen(false); composerRef.current?.focus(); }} />}
    {settingsOpen && <SettingsDialog
      client={client}
      sessionId={sessionId}
      projectRoot={projectRoot}
      status={status}
      settings={settings}
      patch={patch}
      keyNotice={keyNotice}
      link={link}
      counts={panelProps.counts}
      waiting={panelProps.waiting}
      onReconnect={() => void reconnect()}
      onClose={() => setSettingsOpen(false)}
    />}
  </div>;
}
