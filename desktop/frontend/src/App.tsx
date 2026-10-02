import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient, type Client, type Transport } from './protocol';
import { createSlotRegistry, SLOTS, type Panel } from './slots';
import { metaRow, projectRecord, type Record_, type Row } from './rows';

export type Status = {
  sessionId: string;
  running: boolean;
  tools: string[];
  mode: string;
  denials: { consecutive: number; total: number };
  eventCount: number;
};

type Session = { id: string; label: string };
type Ask = { id: string; tool: string; detail: string; reason: string };
type Verbosity = 'brief' | 'standard' | 'detailed' | 'full';

type PanelProps = {
  client: Client;
  status: Status | null;
  sessionId: string | null;
  running: boolean;
  waiting: number;
  counts: { sent: number; received: number };
  sessions: number;
};

const VERBOSITY_KEY = 'ligule.verbosity';
const code = (error: unknown): string => (error as { code?: string; message?: string }).code
  ?? (error as { message?: string }).message ?? String(error);

// 已经接上的三项。
const menuPanels: Panel<PanelProps>[] = [
  {
    id: 'panel.status',
    title: '工具与档位',
    view: ({ status }) => status === null
      ? <p className="stub">还没有会话，读不到状态。</p>
      : <>
        <h3>档位 {status.mode} · 工具 {status.tools.length} 件 · 记录 {status.eventCount} 条 · {status.running ? '正在跑' : '空闲'}</h3>
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
    view: ({ counts, waiting, sessions }) => <>
      <ul>
        <li>发出的帧：{counts.sent}</li>
        <li>收到的帧：{counts.received}</li>
        <li>还没答复的调用：{waiting}</li>
        <li>会话：{sessions}</li>
      </ul>
      <p className="stub">载体是标准输入输出两根管道，本机没有监听端口（D30）；界面拿不到地址与凭据。</p>
    </>,
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

const statusPanels: Panel<PanelProps>[] = [
  {
    id: 'status.pills',
    title: '运行状态',
    view: ({ status, running, waiting }) => <>
      {running && <span className="pill" data-tone="running">正在跑</span>}
      {waiting > 0 && <span className="pill" data-tone="running">在等人答复</span>}
      {status !== null && <>
        <span className="pill">档位 {status.mode}</span>
        <span className="pill">工具 {status.tools.length} 件</span>
        <span className="pill">记录 {status.eventCount} 条</span>
        {status.denials.total > 0 && <span className="pill">不允许 {status.denials.consecutive}/{status.denials.total}</span>}
      </>}
    </>,
  },
];

function RowView({ row }: { row: Row }) {
  if (row.kind === 'question') {
    return <article className="row question"><div className="row-head">你</div><div className="row-body">{row.text}</div></article>;
  }
  if (row.kind === 'reasoning') {
    return <details className="row reasoning"><summary className="row-head">推理段</summary><div className="row-body">{row.text}</div></details>;
  }
  if (row.kind === 'answer') {
    return <article className="row answer"><div className="row-head">助手</div><div className="row-body">{row.text}</div></article>;
  }
  if (row.kind === 'call') {
    return <article className="row call"><div className="row-head">调用 {row.tool}</div><div className="row-body">{row.text}</div></article>;
  }
  if (row.kind === 'result' || row.kind === 'refusal' || row.kind === 'failure') {
    const label = row.kind === 'result' ? `${row.tool} · 完成` : row.kind === 'refusal' ? `${row.tool} · 没让做（${row.code}）` : `${row.tool} · ${row.code}`;
    return <article className={`row ${row.kind}`} data-failed={row.kind === 'result' ? 'false' : 'true'}>
      <div className="row-head">{label}</div>
      <div className="row-body">{row.text}</div>
    </article>;
  }
  return <article className={`row ${row.kind}`}><div className="row-head">{row.kind === 'meta' ? '界面' : '出问题了'}</div><div className="row-body">{row.text}</div></article>;
}

export function App({ transport }: { transport: Transport }) {
  const client = useMemo(() => createClient(transport), [transport]);
  const registry = useMemo(() => {
    const created = createSlotRegistry<PanelProps>(SLOTS);
    for (const panel of [...menuPanels, ...pendingPanels]) created.register('rail.menu', panel);
    for (const panel of statusPanels) created.register('header.status', panel);
    return created;
  }, []);

  const [sessions, setSessions] = useState<Session[]>([]);
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
        if (record?.kind === 'assistant') setLive((current) => ({ ...current, text: '' }));
        if (record?.kind === 'reasoning') setLive((current) => ({ ...current, reasoning: '' }));
        const added = projectRecord(record);
        if (added.length > 0) setRows((current) => [...current, ...added]);
      }
    });

    client.onRequest((message) => {
      // Host 朝界面发出去的请求只有 approval.request 这一种。
      if (message.method !== 'approval.request') return;
      const params = message.params as { sessionId?: string; tool?: string; command?: string; args?: unknown; reason?: string };
      if (params?.sessionId !== active.current) return;
      setAsk({
        id: message.id ?? '',
        tool: params.tool ?? '',
        detail: params.command ?? JSON.stringify(params.args ?? {}, null, 2),
        reason: params.reason ?? '',
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
      setSessions((current) => [...current, { id: created.sessionId, label: '（还没有输入）' }]);
      setSessionId(created.sessionId);
      setRows([]);
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

  // 换会话只切界面：那份会话在这个进程里已经是打开的，再发一次 session.open 会被 Host 拒掉。
  const switchSession = useCallback(async (id: string) => {
    setSessionId(id);
    setRows([]);
    setLive({ text: '', reasoning: '' });
    setAsk(null);
    try {
      const { events } = await client.call('session.read', { sessionId: id }) as { events: Record_[] };
      setRows(events.flatMap((record) => projectRecord(record)));
    } catch (error) {
      setRows((current) => [...current, metaRow('error', `记录读不回来：${code(error)}`)]);
    }
    void refreshStatus(id);
  }, [client, refreshStatus]);

  const readBack = useCallback(async () => {
    if (sessionId === null) return;
    await switchSession(sessionId);
  }, [sessionId, switchSession]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (text === '' || sessionId === null || running) return;
    setDraft('');
    setSessions((current) => current.map((item) => (item.id === sessionId && item.label === '（还没有输入）'
      ? { ...item, label: text.slice(0, 24) }
      : item)));
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
    sessions: sessions.length,
  };
  const current = sessions.find((item) => item.id === sessionId);

  return <div className="frame">
    <aside className="sidebar">
      <div className="brand"><img src="/icon.png" alt="" width="22" height="22" /><span>ligule</span></div>
      <button className="new-run" type="button" onClick={() => void newSession()}>新建会话</button>
      <div className="section-label">会话</div>
      <div className="sessions">
        {sessions.length === 0 && <div className="session-item">这一次运行还没有会话</div>}
        {sessions.map((item) => <button
          key={item.id}
          type="button"
          className={`session-item${item.id === sessionId ? ' active' : ''}`}
          onClick={() => void switchSession(item.id)}
        >{item.label}</button>)}
      </div>
      <div className="sidebar-foot">
        <button className="entry" type="button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
          <span className="entry-glyph">⌗</span><span>功能</span>
        </button>
      </div>
    </aside>

    <main className="center">
      <header className="topbar">
        <div className="title">
          <strong id="session-title">{current === undefined ? '没有会话' : `会话 ${current.id.slice(0, 8)}`}</strong>
          <span className="muted" id="session-note">{current === undefined ? '后端进程由壳起，帧走管道' : current.label}</span>
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

      <div className="conversation" data-verbosity={verbosity} aria-live="polite">
        {rows.length === 0 && live.text === '' && <p className="empty">还没有轮次。下方输入一句话，Enter 直接开始。</p>}
        {live.reasoning !== '' && <details className="row reasoning" open={verbosity === 'full'}><summary className="row-head">推理段（流式）</summary><div className="row-body">{live.reasoning}</div></details>}
        {live.text !== '' && <article className="row answer"><div className="row-head">助手</div><div className="row-body">{live.text}</div></article>}
        {rows.map((row) => <RowView key={row.id} row={row} />)}
      </div>

      {ask !== null && <section className="approval">
        <div className="approval-head">
          <span className="approval-kind">要执行</span>
          <strong>{ask.tool}</strong>
          <code>{ask.detail}</code>
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
