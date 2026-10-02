// 桌面壳的界面主干（第 15 步）。三件事分开放：帧的读写在 protocol.js，能挂东西的位置在 slots.js，
// 这里只把会话记录画成行、把审批摆出来、把状态读成几枚标记。
// 布局与槽位命名照 dsh 的客户端（`packages/client/ui-layout/src/client/columns.ts` 的几何取值、
// `packages/client/ui-approval/src/client/contract/slots.ts` 的槽位与审批答复），没有另起一套设计。
import { createClient } from './protocol.js';
import { createSlotRegistry, SLOTS } from './slots.js';

const tauri = window.__TAURI__;
const frames = { sent: 0, received: 0, faults: 0 };
const state = { session: null, sessions: [], status: null, ask: null, running: false };

const slots = createSlotRegistry(SLOTS);

const on = (id) => document.getElementById(id);
const els = {
  newSession: on('new-session'),
  sessions: on('sessions'),
  menuToggle: on('menu-toggle'),
  panelMenu: on('panel-menu'),
  sessionTitle: on('session-title'),
  sessionNote: on('session-note'),
  pills: on('pills'),
  verbosity: on('verbosity'),
  readBack: on('read-back'),
  cancelRun: on('cancel-run'),
  conversation: on('conversation'),
  approval: on('approval'),
  approvalTool: on('approval-tool'),
  approvalDetail: on('approval-detail'),
  approvalReason: on('approval-reason'),
  allow: on('allow'),
  deny: on('deny'),
  input: on('input'),
  transportNote: on('transport-note'),
  send: on('send'),
  dock: on('dock'),
  dockTitle: on('dock-title'),
  dockClose: on('dock-close'),
  dockBody: on('dock-body'),
};

// ---------- 帧 ----------

const client = createClient({
  send(frame) {
    frames.sent += 1;
    drawTransport();
    if (tauri) void tauri.core.invoke('host_send', { frame });
  },
});

function drawTransport() {
  els.transportNote.textContent = tauri
    ? `帧走管道 · 出 ${frames.sent} 条 / 入 ${frames.received} 条`
    : '没有宿主：直接在浏览器里打开这个文件收不到帧';
}

// ---------- 行 ----------

const bodyOf = (node) => node.querySelector('.row-body');

function newRow(kind, label) {
  const node = document.createElement('article');
  node.className = `row ${kind}`;
  node.dataset.kind = kind;
  const head = document.createElement('div');
  head.className = 'row-head';
  head.textContent = label;
  const body = document.createElement('div');
  body.className = 'row-body';
  node.append(head, body);
  return node;
}

// 推理段是一条能收起来的东西：默认收着，看不看得见由「工作步骤展示」那一档决定（D32）。
function newDetails(kind, label) {
  const node = document.createElement('details');
  node.className = `row ${kind}`;
  node.dataset.kind = kind;
  const head = document.createElement('summary');
  head.className = 'row-head';
  head.textContent = label;
  const body = document.createElement('div');
  body.className = 'row-body';
  node.append(head, body);
  return node;
}

function appendRow(kind, label, text) {
  const node = newRow(kind, label);
  bodyOf(node).textContent = text;
  addNodes([node]);
  return node;
}

function addNodes(nodes) {
  els.conversation.querySelector('.empty')?.remove();
  for (const node of nodes) {
    // 流式期间已经在场的那一行由这里补内容，不重新挂一次，位置不变。
    if (node.parentElement === null) els.conversation.append(node);
  }
  els.conversation.scrollTop = els.conversation.scrollHeight;
}

function clearConversation() {
  els.conversation.replaceChildren();
  const hint = document.createElement('p');
  hint.className = 'empty';
  hint.textContent = '还没有轮次。下方输入一句话，或按 Ctrl+Enter 直接开始。';
  els.conversation.append(hint);
}

// 一次工具调用一张卡片，结果按 callId 认回同一张：并发执行的那几组会交错落盘（D29），
// 按落盘次序排会把两次调用的结果接错。
function callRow(call) {
  const node = newRow('call', `调用 ${call.name}`);
  node.dataset.callId = call.id;
  bodyOf(node).textContent = JSON.stringify(call.args ?? {}, null, 2);
  return node;
}

// 记录里的每一条怎么画，注册进 conversation.rows：以后加一类记录就是往这张表里加一项，主干不动。
const RECORD_ROWS = [
  {
    kind: 'user',
    render(record) {
      const node = newRow('question', '你');
      bodyOf(node).textContent = record.text;
      return [node];
    },
  },
  {
    // liveType 把这一类记录与流式期间的那一行对上：通报过来的原文与刚落盘的同一条内容，只画一次。
    kind: 'assistant',
    liveType: 'text',
    render(record, reuse) {
      const nodes = [];
      if (reuse !== null || record.text !== '') {
        const node = reuse ?? newRow('answer', '助手');
        bodyOf(node).textContent = record.text;
        nodes.push(node);
      }
      for (const call of record.toolCalls ?? []) nodes.push(callRow(call));
      return nodes;
    },
  },
  {
    kind: 'reasoning',
    liveType: 'reasoning',
    render(record, reuse) {
      const node = reuse ?? newDetails('reasoning', '推理段');
      bodyOf(node).textContent = record.text;
      return [node];
    },
  },
  {
    kind: 'tool',
    render(record) {
      const failed = record.result?.failed === true;
      const node = newRow('result', `${record.tool} · ${failed ? record.result.code : '完成'}`);
      node.dataset.failed = String(failed);
      const pending = els.conversation.querySelector(`.row.call[data-call-id="${record.callId}"]`);
      if (pending !== null) pending.dataset.answered = 'true';
      const label = record.result?.reason ?? record.result?.content ?? '';
      bodyOf(node).textContent = typeof label === 'string' ? label : JSON.stringify(label, null, 2);
      return [node];
    },
  },
];

const renderers = new Map();
for (const spec of RECORD_ROWS) {
  slots.register('conversation.rows', spec);
  renderers.set(spec.kind, spec);
}

function renderRecord(record) {
  const spec = renderers.get(record.kind);
  if (spec === undefined) return;
  const reuse = spec.liveType === undefined
    ? null
    : els.conversation.querySelector(`.row[data-live="${spec.liveType}"]`);
  if (reuse !== null) delete reuse.dataset.live;
  addNodes(spec.render(record, reuse));
}

// ---------- 流式增量 ----------

function appendDelta(event) {
  if (event.type !== 'text' && event.type !== 'reasoning') return;
  let node = els.conversation.querySelector(`.row[data-live="${event.type}"]`);
  if (node === null) {
    node = event.type === 'text' ? newRow('answer', '助手') : newDetails('reasoning', '推理段');
    node.dataset.live = event.type;
    node.open = true;
    addNodes([node]);
  }
  bodyOf(node).textContent += event.text ?? '';
  els.conversation.scrollTop = els.conversation.scrollHeight;
}

// ---------- 状态标记与侧栏 ----------

function pill(text, tone) {
  const node = document.createElement('span');
  node.className = 'pill';
  node.textContent = text;
  if (tone !== undefined) node.dataset.tone = tone;
  return node;
}

// 头部那几枚标记挂在 header.status 槽位上：以后往桌面版加状态，注册一个面板就出现在这里。
slots.register('header.status', {
  id: 'status.pills',
  title: '运行状态',
  render(body) {
    const status = state.status;
    if (state.running) body.append(pill('正在跑', 'running'));
    if (state.ask !== null) body.append(pill('在等人答复', 'running'));
    if (status) {
      body.append(pill(`档位 ${status.mode}`));
      body.append(pill(`工具 ${status.tools.length} 件`));
      body.append(pill(`记录 ${status.eventCount} 条`));
      if (status.denials.total > 0) body.append(pill(`不允许 ${status.denials.consecutive}/${status.denials.total}`));
    }
  },
});

// 会话列表：这一份壳只管自己起的那个 Host 进程，列表里就是这一次运行里建过或开过的会话。
slots.register('rail.sessions', {
  id: 'rail.sessions.list',
  title: '会话',
  render(body) {
    if (state.sessions.length === 0) {
      const none = document.createElement('div');
      none.className = 'session-item';
      none.textContent = '这一次运行还没有会话';
      body.append(none);
      return;
    }
    for (const session of state.sessions) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `session-item${session.id === state.session ? ' active' : ''}`;
      item.textContent = session.label;
      item.addEventListener('click', () => void switchSession(session.id));
      body.append(item);
    }
  },
});

function drawPills() {
  els.pills.replaceChildren();
  for (const panel of slots.list('header.status')) panel.render(els.pills);
}

function drawSessions() {
  els.sessions.replaceChildren();
  for (const panel of slots.list('rail.sessions')) panel.render(els.sessions);
}

function drawHeadline() {
  const session = state.sessions.find((entry) => entry.id === state.session);
  els.sessionTitle.textContent = session === undefined ? '没有会话' : `会话 ${session.id.slice(0, 8)}`;
  els.sessionNote.textContent = session === undefined
    ? '后端进程由壳起，帧走管道'
    : `这一次运行的第 ${state.sessions.length} 份会话 · ${session.label}`;
}

// ---------- 会话与轮次 ----------

async function refreshStatus() {
  if (state.session === null) return;
  try {
    state.status = await client.call('status.get', { sessionId: state.session });
  } catch (error) {
    appendRow('error', '状态读不到', error.code ?? String(error.message));
    return;
  }
  drawPills();
}

function setRunning(running) {
  state.running = running;
  els.cancelRun.disabled = !running;
  els.send.disabled = running || state.session === null;
  drawPills();
}

async function createSession() {
  els.send.disabled = true;
  try {
    const created = await client.call('session.create', {});
    state.session = created.sessionId;
    state.sessions.push({ id: created.sessionId, label: '（还没有输入）' });
    clearConversation();
    drawSessions();
    drawHeadline();
    await refreshStatus();
    setRunning(state.running);
  } catch (error) {
    appendRow('error', '会话建不起来', error.code ?? String(error.message));
  }
}

// 换会话只切界面：那份会话在这个进程里已经是打开的，再发一次 session.open 会被 Host 拒掉。
async function switchSession(id) {
  state.session = id;
  clearConversation();
  drawSessions();
  drawHeadline();
  await readBack();
  await refreshStatus();
}

async function readBack() {
  if (state.session === null) return;
  try {
    const { events } = await client.call('session.read', { sessionId: state.session });
    clearConversation();
    for (const event of events) renderRecord(event);
  } catch (error) {
    appendRow('error', '记录读不回来', error.code ?? String(error.message));
  }
}

async function startRun(input) {
  const session = state.sessions.find((entry) => entry.id === state.session);
  if (session !== undefined && session.label === '（还没有输入）') {
    session.label = input.slice(0, 24);
    drawSessions();
    drawHeadline();
  }
  setRunning(true);
  try {
    const result = await client.call('run.start', { sessionId: state.session, input });
    const extra = result.completedBy === undefined ? '' : `，由 ${result.completedBy} 收尾`;
    appendRow('meta', '本轮结束', `${result.iterations} 次迭代、${result.modelCalls} 次模型调用${extra}`);
  } catch (error) {
    appendRow('error', '这一轮停住', error.code ?? String(error.message));
  } finally {
    setRunning(false);
    withdrawAsk('这一轮已经不在跑了');
    await refreshStatus();
  }
}

async function cancelRun() {
  if (state.session === null) return;
  try {
    await client.call('run.cancel', { sessionId: state.session });
  } catch (error) {
    appendRow('meta', '取消没生效', error.code ?? String(error.message));
  }
}

// ---------- 审批 ----------

client.onRequest((message) => {
  // Host 朝界面发出去的请求只有 approval.request 这一种（protocol.js 的 APPROVAL_METHOD）。
  if (message.method !== 'approval.request') return;
  state.ask = message.id;
  els.approvalTool.textContent = message.params.tool;
  const described = message.params.command ?? JSON.stringify(message.params.args ?? {}, null, 2);
  els.approvalDetail.textContent = described;
  els.approvalReason.textContent = message.params.reason ?? '';
  els.allow.disabled = false;
  els.deny.disabled = false;
  els.approval.hidden = false;
  drawPills();
});

function answerAsk(decision) {
  if (state.ask === null) return;
  const asked = state.ask;
  const tool = els.approvalTool.textContent;
  hideAsk();
  // 先把这一条记在界面上再发答复：答复一发出去，Host 那一边就往下跑，工具结果可能比这一行先到。
  appendRow('meta', decision === 'allow' ? '已允许' : '已不允许', tool);
  client.reply(asked, { decision });
}

// 取消落在还没答复的审批上时，Host 那一边把等待收掉了（host.js 的 Promise.race），
// 这个问题不会再有答复，界面上也不能留着让人去点。
function withdrawAsk(note) {
  if (state.ask === null) return;
  appendRow('meta', '问题撤掉了', note);
  hideAsk();
}

function hideAsk() {
  state.ask = null;
  els.approval.hidden = true;
  drawPills();
}

// ---------- 右侧面板与功能菜单 ----------

const STUB = (id, title, why) => ({
  id,
  title,
  pending: true,
  render(body) {
    const node = document.createElement('p');
    node.className = 'stub';
    node.textContent = why;
    body.append(node);
  },
});

// 已经接上的三项。
slots.register('rail.menu', {
  id: 'panel.status',
  title: '工具与档位',
  async render(body) {
    if (state.session === null) return;
    let status;
    try {
      status = await client.call('status.get', { sessionId: state.session });
    } catch (error) {
      body.append(newStub(error.code ?? String(error.message)));
      return;
    }
    const heading = document.createElement('h3');
    heading.textContent = `档位 ${status.mode} · 工具 ${status.tools.length} 件 · 记录 ${status.eventCount} 条 · ${status.running ? '正在跑' : '空闲'}`;
    const denials = document.createElement('p');
    denials.className = 'stub';
    denials.textContent = `判定链记的拒绝：连续 ${status.denials.consecutive} 次、累计 ${status.denials.total} 次。`
      + '连续次数到阈值时档位自动回到逐次询问（D17）。';
    const list = document.createElement('ul');
    for (const name of status.tools) {
      const item = document.createElement('li');
      item.textContent = name;
      list.append(item);
    }
    body.append(heading, denials, list);
  },
});

slots.register('rail.menu', {
  id: 'panel.shortcuts',
  title: '快捷键',
  render(body) {
    const list = document.createElement('ul');
    for (const [keys, what] of [
      ['Enter', '发送'],
      ['Shift+Enter', '换行'],
      ['Ctrl+Enter', '发送'],
      ['Esc', '输入框里取消这一轮；别处关掉菜单与右侧面板'],
    ]) {
      const item = document.createElement('li');
      item.textContent = `${keys} —— ${what}`;
      list.append(item);
    }
    body.append(list);
  },
});

slots.register('rail.menu', {
  id: 'panel.frames',
  title: '这一条连接',
  render(body) {
    const list = document.createElement('ul');
    for (const [label, value] of [
      ['发出的帧', frames.sent],
      ['收到的帧', frames.received],
      ['连接上的失败', frames.faults],
      ['还没答复的调用', client.waiting()],
      ['会话', state.sessions.length],
    ]) {
      const item = document.createElement('li');
      item.textContent = `${label}：${value}`;
      list.append(item);
    }
    const note = newStub('这一份是打开面板时的读数。载体是标准输入输出两根管道，本机没有监听端口（D30）。');
    body.append(list, note);
  },
});

// 还没有实现的四项：菜单里看得见，点开只说明缺的是哪一件，不做半只的开关。
slots.register('rail.menu', STUB('panel.policy', '审批规则',
  '档位现在是整个运行一份，按工具名一份那一档没定（todo.md 的 U22）。'
  + '界面在这里放开关就等于替那条未定项做决定，所以先不放。'));
slots.register('rail.menu', STUB('panel.appearance', '外观与主题',
  '只有「工作步骤展示」那一档接上了，它在顶部工具条上。主题、字号与侧栏宽度还没有存起来的地方。'));
slots.register('rail.menu', STUB('panel.model', '模型与端点',
  '服务地址与模型名读的是配置文件那三层（D8），协议表里六条方法没有一条读写配置（src/host/protocol.js）。'
  + '这一项要先加方法，界面改配置才谈得上。'));
slots.register('rail.menu', STUB('panel.windows', '多窗口与重连',
  '一份壳对应一个 Host 进程，会话状态在那个进程里（D30）。'
  + '多个窗口看同一会话要等共享常驻进程引入（U8）；进程断掉之后记录里那批没结果的调用怎么补也没定（U21）。'));

function newStub(text) {
  const node = document.createElement('p');
  node.className = 'stub';
  node.textContent = text;
  return node;
}

function pendingTag() {
  const tag = document.createElement('span');
  tag.className = 'menu-tag';
  tag.textContent = '待实现';
  return tag;
}

function openPanel(panel) {
  els.dockTitle.replaceChildren(panel.title);
  if (panel.pending === true) els.dockTitle.append(pendingTag());
  els.dockBody.replaceChildren();
  els.dock.hidden = false;
  closeMenu();
  void panel.render(els.dockBody);
}

function closeMenu() {
  els.panelMenu.hidden = true;
  els.menuToggle.setAttribute('aria-expanded', 'false');
}

function drawMenu() {
  els.panelMenu.replaceChildren();
  for (const panel of slots.list('rail.menu')) {
    const item = document.createElement('button');
    item.type = 'button';
    item.role = 'menuitem';
    item.append(panel.title);
    if (panel.pending === true) item.append(pendingTag());
    item.addEventListener('click', () => openPanel(panel));
    els.panelMenu.append(item);
  }
}

els.menuToggle.addEventListener('click', () => {
  const opening = els.panelMenu.hidden;
  if (opening) drawMenu();
  els.panelMenu.hidden = !opening;
  els.menuToggle.setAttribute('aria-expanded', String(opening));
});

els.dockClose.addEventListener('click', () => {
  els.dock.hidden = true;
});

// ---------- 输入 ----------

els.newSession.addEventListener('click', () => void createSession());
els.readBack.addEventListener('click', () => void readBack());
els.cancelRun.disabled = true;
els.cancelRun.addEventListener('click', () => void cancelRun());
els.send.addEventListener('click', () => void submit());
els.allow.addEventListener('click', () => answerAsk('allow'));
els.deny.addEventListener('click', () => answerAsk('deny'));

function submit() {
  const text = els.input.value.trim();
  if (text === '' || state.running || state.session === null) return;
  els.input.value = '';
  void startRun(text);
}

els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  } else if (event.key === 'Escape') {
    if (state.running) void cancelRun();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!els.panelMenu.hidden) closeMenu();
  else if (!els.dock.hidden) els.dock.hidden = true;
});

document.addEventListener('click', (event) => {
  if (els.panelMenu.hidden) return;
  if (els.panelMenu.contains(event.target) || els.menuToggle.contains(event.target)) return;
  closeMenu();
});

const stored = localStorage.getItem('ligule.verbosity') ?? 'standard';
els.verbosity.value = stored;
els.conversation.dataset.verbosity = stored;
els.verbosity.addEventListener('change', () => {
  els.conversation.dataset.verbosity = els.verbosity.value;
  localStorage.setItem('ligule.verbosity', els.verbosity.value);
});

// ---------- 载体接上 ----------

client.onNotification((message) => {
  // 通报带的是它自己那一份会话的 id：界面看的是当前这一份，别的会话在跑时帧照样收，只是不画到眼前。
  if (message.notify !== 'fault' && message.sessionId !== state.session) return;
  if (message.notify === 'delta') appendDelta(message.event);
  else if (message.notify === 'event') renderRecord(message.event);
  else if (message.notify === 'fault') {
    frames.faults += 1;
    appendRow('error', '连接上的问题', `${message.code}：${message.detail ?? ''}`);
  }
});

if (tauri) {
  void tauri.event.listen('host-frame', (event) => {
    frames.received += 1;
    const seen = client.receive(event.payload);
    if (seen.kind === 'unparsed') appendRow('error', '读不出来的帧', event.payload);
    drawTransport();
  });
  // Host 进程的标准错误输出走到这里：它不是协议帧，是那一侧打印的东西。
  void tauri.event.listen('host-log', (event) => appendRow('meta', '宿主输出', event.payload));
}

drawTransport();
drawPills();
drawSessions();
drawHeadline();
if (tauri) void createSession();
