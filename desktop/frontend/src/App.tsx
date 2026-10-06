import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient, type Client, type Transport } from './protocol';
import { RowView } from './components/RowView';
import { SessionRail } from './components/SessionRail';
import type { Verbosity } from './components/types';
import { createSlotRegistry, SLOTS, type Panel } from './slots';
import { metaRow, projectRecord, type Record_, type Row } from './rows';

export type Status = {
  sessionId: string;
  running: boolean;
  tools: string[];
  // 模式名与判定档位是两样东西，字段也分开（D40：界面上 `mode` 这个词不该同时指两处）。
  mode: string | null;
  modeLayer: string | null;
  pendingMode: string | null;
  policy: string;
  denials: { consecutive: number; total: number };
  eventCount: number;
};

type Ask = { id: string; tool: string; detail: string; reason: string; backend: string };
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
  waiting: number;
  counts: { sent: number; received: number };
  openSession: (id: string) => void;
  verbosity: Verbosity;
};

const VERBOSITY_KEY = 'ligule.verbosity';
const code = (error: unknown): string => (error as { code?: string; message?: string }).code
  ?? (error as { message?: string }).message ?? String(error);

// 已经接上的四项。
const menuPanels: Panel<PanelProps>[] = [
  {
    id: 'panel.status',
    title: '工具与档位',
    view: ({ status }) => status === null
      ? <p className="stub">还没有会话，读不到状态。</p>
      : <>
        <h3>模式 {status.mode ?? '没装'} · 档位 {status.policy} · 工具 {status.tools.length} 件 · 记录 {status.eventCount} 条 · {status.running ? '正在跑' : '空闲'}</h3>
        <p className="stub">判定链记的拒绝：连续 {status.denials.consecutive} 次、累计 {status.denials.total} 次。连续次数到阈值时档位自动回到逐次询问（D17）。</p>
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
      <li>Esc —— 输入框里取消这一轮；别处关掉菜单与右侧面板</li>
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
    view: ({ client, sessionId, verbosity }) => <BranchPanel client={client} sessionId={sessionId} verbosity={verbosity} />,
  },
];

// 还没有实现的四项：菜单里看得见，点开只说明缺的是哪一件，不做半只的开关。
const pendingPanels: Panel<PanelProps>[] = [
  {
    id: 'panel.policy',
    title: '审批规则',
    pending: true,
    view: () => <p className="stub">档位现在是整个运行一份，按工具名一份那一档没定（未定项 U22）。界面在这里放开关就等于替那条未定项做决定，所以先不放。</p>,
  },
  {
    id: 'panel.appearance',
    title: '外观与主题',
    pending: true,
    view: () => <p className="stub">只有「工作步骤展示」那一档接上了，它在顶部工具条上。主题、字号与侧栏宽度还没有存起来的地方。</p>,
  },
  {
    id: 'panel.model',
    title: '模型与端点',
    pending: true,
    view: () => <p className="stub">服务地址与模型名读的是配置文件那三层（D8），协议表里六条方法没有一条读写配置。这一项要先加方法，界面改配置才谈得上。</p>,
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

const statusPanels: Panel<PanelProps>[] = [  {
    id: 'status.pills',
    title: '运行状态',
    view: ({ status, running, waiting }) => <>
      {running && <span className="pill" data-tone="running">正在跑</span>}
      {waiting > 0 && <span className="pill" data-tone="running">在等人答复</span>}
      {status !== null && <>
        <span className="pill">模式 {status.mode ?? '没装'}</span>
        <span className="pill">档位 {status.policy}</span>
        <span className="pill">工具 {status.tools.length} 件</span>
        <span className="pill">记录 {status.eventCount} 条</span>
        {status.denials.total > 0 && <span className="pill">不允许 {status.denials.consecutive}/{status.denials.total}</span>}
      </>}
    </>,
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
  const [ask, setAsk] = useState<Ask | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<Panel<PanelProps> | null>(null);
  const [verbosity, setVerbosity] = useState<Verbosity>(() => (localStorage.getItem(VERBOSITY_KEY) as Verbosity) ?? 'standard');
  const active = useRef<string | null>(null);
  // 跟随最新：贴在底部时新内容进来就滚到底；人往上翻过就不再自动滚，给一个跳回最新的按钮。
  const scroller = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);
  const [limit, setLimit] = useState(RENDER_WINDOW);
  // 那一次派发是什么时候交出去的：只为算用时，键是调用 id（D94）。
  const dispatchAt = useRef(new Map<string, number>());

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
    localStorage.setItem(VERBOSITY_KEY, verbosity);
  }, [verbosity]);

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
      const params = message.params as { sessionId?: string; tool?: string; command?: string; args?: unknown; reason?: string; shell?: string; executable?: string };
      if (params?.sessionId !== active.current) return;
      setAsk({
        id: message.id ?? '',
        tool: params.tool ?? '',
        detail: params.command ?? JSON.stringify(params.args ?? {}, null, 2),
        reason: params.reason ?? '',
        // 同一条文本在两种语法下能自动放行的面积不一样，答的是哪一种、跑的是哪一个可执行文件要看得见（D59）。
        backend: params.shell === undefined ? '' : `${params.shell} · ${params.executable ?? ''}`,
      });
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
      setAsk(null);
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
    setAsk(null);
    dispatchAt.current.clear();
    try {
      await client.call('session.open', { sessionId: id });
      // fullResults 那一格是给界面读的：溢出文件里的整段正文这才到得了画面（记录本身不动）。
      const { events } = await client.call('session.read', { sessionId: id, fullResults: true }) as { events: Record_[] };
      setRows(events.flatMap((record) => projectRecord(record)));
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `那份会话接不上：${code(error)}`)]);
    }
    void refreshStatus(id);
  }, [client, refreshStatus]);

  const readBack = useCallback(async () => {
    if (sessionId === null) return;
    await openSession(sessionId);
  }, [sessionId, openSession]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (text === '' || sessionId === null || running) return;
    setDraft('');
    setRunning(true);
    try {
      const result = await client.call('run.start', { sessionId, input: text }) as { iterations: number; modelCalls: number; completedBy?: string };
      setRows((current) => [...current, metaRow('meta', `本轮结束：${result.iterations} 次迭代、${result.modelCalls} 次模型调用${result.completedBy === undefined ? '' : `，由 ${result.completedBy} 收尾`}`)]);
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `这一轮停住：${code(error)}`)]);
    } finally {
      setRunning(false);
      setAsk(null);
      void refreshStatus(sessionId);
    }
  }, [client, draft, refreshStatus, running, sessionId]);

  const cancel = useCallback(async () => {
    if (sessionId === null) return;
    try {
      await client.call('run.cancel', { sessionId });
    } catch (error) {
      setRows((current) => [...current, metaRow('meta', `取消没生效：${code(error)}`)]);
    }
  }, [client, sessionId]);

  const answer = useCallback((decision: 'allow' | 'deny') => {
    if (ask === null) return;
    const asked = ask;
    setAsk(null);
    // 先把这一条记在界面上再发答复：答复一发出去，Host 那一边就往下跑，工具结果可能比这一行先到。
    setRows((current) => [...current, metaRow('meta', `${decision === 'allow' ? '已允许' : '已不允许'} ${asked.tool}`)]);
    client.reply(asked.id, { decision });
  }, [ask, client]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (menuOpen) setMenuOpen(false);
      else if (panel !== null) setPanel(null);
      else if (running) void cancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cancel, menuOpen, panel, running]);

  const panelProps: PanelProps = {
    client,
    status,
    sessionId,
    running,
    waiting: client.waiting(),
    counts: client.counts(),
    openSession,
    verbosity,
  };
  const hidden = Math.max(0, rows.length - limit);

  return <div className="frame">
    <aside className="sidebar">
      <div className="brand"><img src="/icon.png" alt="" width="22" height="22" /><span>ligule</span></div>
      <button className="new-run" type="button" onClick={() => void newSession()}>新建会话</button>
      <div className="section-label">会话</div>
      {registry.list('rail.sessions').map((item) => <div key={item.id} className="rail-slot">{item.view(panelProps)}</div>)}
      <div className="sidebar-foot">
        <button className="entry" type="button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
          <span className="entry-glyph">⌗</span><span>功能</span>
        </button>
      </div>
    </aside>

    <main className="center">
      <header className="topbar">
        <div className="title">
          <strong id="session-title">{sessionId === null ? '没有会话' : `会话 ${sessionId.slice(0, 8)}`}</strong>
          <span className="muted" id="session-note">{status === null ? '后端进程由壳起，帧走管道' : `模式 ${status.mode ?? '没装'} · 记录 ${status.eventCount} 条`}</span>
        </div>
        <div className="pills">{registry.list('header.status').map((item) => <span key={item.id}>{item.view(panelProps)}</span>)}</div>
        <label className="verbosity">
          <span>工作步骤展示</span>
          <select value={verbosity} onChange={(event) => setVerbosity(event.target.value as Verbosity)}>
            <option value="brief">简洁</option>
            <option value="standard">标准</option>
            <option value="detailed">详细</option>
            <option value="full">完全展开</option>
          </select>
        </label>
      </header>

      <div className="conversation" data-verbosity={verbosity} aria-live="polite" ref={scroller} onScroll={onScroll}>
        {rows.length === 0 && live.text === '' && <p className="empty">还没有轮次。下方输入一句话，Enter 直接开始。</p>}
        {hidden > 0 && <button type="button" className="earlier" onClick={() => setLimit((n) => n + RENDER_WINDOW)}>显示更早的 {hidden} 行</button>}
        {rows.slice(hidden).map((row) => <RowView key={row.id} row={row} verbosity={verbosity} />)}
        {/* 流式那半截排在已落盘的那些行之后：它是这一轮的末尾，画到开头去就把因果倒过来了。 */}
        {live.reasoning !== '' && <RowView row={{ ...LIVE_REASONING, text: live.reasoning }} verbosity={verbosity} />}
        {live.text !== '' && <RowView row={{ ...LIVE_ANSWER, text: live.text }} verbosity={verbosity} />}
      </div>
      {!pinned && <button className="jump-latest" type="button" onClick={() => void jumpToLatest()}>回到最新</button>}

      {ask !== null && <section className="approval">
        <div className="approval-head">
          <span className="approval-kind">要执行</span>
          <strong>{ask.tool}</strong>
          <code>{ask.detail}</code>
          {ask.backend !== '' && <span className="approval-backend">{ask.backend}</span>}
        </div>
        {ask.reason !== '' && <p className="approval-reason">{ask.reason}</p>}
        <div className="approval-actions">
          <button type="button" onClick={() => answer('allow')}>允许一次</button>
          <button type="button" onClick={() => answer('deny')}>不允许</button>
        </div>
      </section>}

      <footer className="composer">
        <textarea
          rows={3}
          value={draft}
          placeholder="要模型做的事（Enter 发送，Shift+Enter 换行）"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-actions">
          <span className="muted">帧走管道 · 出 {panelProps.counts.sent} 条 / 入 {panelProps.counts.received} 条</span>
          <button type="button" onClick={() => void readBack()}>读回记录</button>
          <button type="button" disabled={!running} onClick={() => void cancel()}>取消本轮</button>
          <button type="button" className="primary" disabled={running || sessionId === null} onClick={() => void send()}>发送</button>
        </div>
      </footer>
    </main>

    {panel !== null && <aside className="dock">
      <div className="dock-head">
        <strong className="dock-title">{panel.title}{panel.pending === true && <span className="menu-tag">待实现</span>}</strong>
        <button type="button" aria-label="关闭面板" onClick={() => setPanel(null)}>✕</button>
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
  </div>;
}
