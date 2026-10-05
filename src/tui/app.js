// 终端界面的行、输入与状态（D33 的第二种客户端）。这里不读帧也不写帧：帧由 src/host/connection.js 那一层交进来，
// 这一层只把会话记录与流式增量画成行，并把按键变成协议里的调用。
// 纯函数（editDraft、foldText、projectRecord、branchOf、detailTitle 与 commands.ts 里那几张表）都从这里交出去，
// 检查在 test/tui.test.js，不靠真终端也能验；画面本身跑 `ligule tui` 看。
import { createElement as h, Fragment, useCallback, useEffect, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { SESSION_ROWS, UI_COMMANDS, candidatesOf, findUiCommand, flowGroups, resolveSessionId, routeInput, sessionLines } from './commands.js';
import { pushHistory, searchHistory } from './history.js';
import { editInExternalEditor } from './editor.js';
import { markdownLines } from './markdown.js';

const SPINNER = ['⠋', '⠙', '', '⠸', '⠼', '⠴', '⠦', '', '⠇', '⠏'];
const FOLD_LINES = 3;
// 模式来自哪一层，画给人看的是中文，记录里那三个名字与装载那一侧一致（D43）。
const MODE_LAYERS = { shipped: '随包', user: '全局', project: '项目' };
// 清单最多画几行：再长就把屏幕顶到输入框以外，人看不到自己在敲什么。
const CANDIDATE_ROWS = 6;

// 那几张表与那几个纯函数交给检查里用（test/tui.test.js），界面自己只走这一处出口。
export { SESSION_ROWS, UI_COMMANDS, candidatesOf, displayWidth, findUiCommand, flowGroups, resolveSessionId, routeInput, sessionLines } from './commands.js';
export { markdownLines } from './markdown.js';

// `/help` 画三组：界面命令、宿主交出来的提示模板、按键。前两组在这里只列名字与说明，展开与装载都不归界面。
const KEYS = [
  { key: 'Enter', action: '发送' },
  { key: 'Shift+Enter', action: '换行' },
  { key: 'Tab', action: '补全清单里选中的那一条' },
  { key: '↑ ↓', action: '在清单里选，清单不在时翻输入历史' },
  { key: 'Ctrl+R', action: '反查发过的那几句' },
  { key: 'Ctrl+G', action: '把草稿交给 EDITOR 里那一份编辑器' },
  { key: 'Esc', action: '收起清单；跑着的时候打断这一轮' },
  { key: 'Ctrl+O', action: '展开或收起长内容' },
  { key: 'Ctrl+C', action: '退出' },
];

// 草稿的编辑：左右移光标、Home/End 与 Ctrl+A/E 跳两端、Ctrl+W 删前一个词、Ctrl+U 清空、其余可打印字符插在光标处。
export function editDraft(draft, caret, input, key) {
  if (key.leftArrow) return { draft, caret: Math.max(0, caret - 1) };
  if (key.rightArrow) return { draft, caret: Math.min(draft.length, caret + 1) };
  if (key.home || (key.ctrl && input === 'a')) return { draft, caret: 0 };
  if (key.end || (key.ctrl && input === 'e')) return { draft, caret: draft.length };
  if (key.ctrl && input === 'u') return { draft: '', caret: 0 };
  if (key.ctrl && input === 'w') {
    // 先跳过光标前的空白，再删一个词：连着空白一起删会让「rm -rf  」整段消失。
    const head = draft.slice(0, caret).replace(/\s+$/, '').replace(/[\w.\-/]+\s*$/, '');
    return { draft: head + draft.slice(caret), caret: head.length };
  }
  if (key.backspace || key.delete) {
    if (caret === 0) return { draft, caret };
    return { draft: draft.slice(0, caret - 1) + draft.slice(caret), caret: caret - 1 };
  }
  if (input === '' || key.ctrl || key.meta) return { draft, caret };
  return { draft: draft.slice(0, caret) + input + draft.slice(caret), caret: caret + input.length };
}

// 工具结果的内容可以是串，也可以是结构化的一段（read 交回的是 {text: ...}）；界面这一处只画文本。
const textOf = (value) => (typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2));

// 长内容默认折起来：行数与字数各给一个上限，剩下的一行说明还有多少字（Ctrl+O 展开）。
// 只按行数折的话，一段没有换行的 JSON 会整块压在屏幕上。
export function foldText(text, expanded, limit = FOLD_LINES, maxChars = 400) {
  const full = textOf(text);
  if (expanded === true) return { shown: full, hidden: 0 };
  const lines = full.split('\n');
  const shown = lines.length > limit ? lines.slice(0, limit).join('\n') : full;
  const cut = shown.length > maxChars ? shown.slice(0, maxChars) : shown;
  return { shown: cut, hidden: full.length - cut.length };
}

// 工具交回的那一份形状是 { text, 附带几格 }：界面画正文，附带那几格画在抬头那一行。
// 正文之外真正要看得见的是两件事——命令跑出来的退出码，与一次 `mcp.call` 真正用的能力名（D52、D59、D77）。
export function resultParts(result) {
  const payload = typeof result.content === 'object' && result.content !== null ? result.content : {};
  return {
    text: typeof payload.text === 'string' ? payload.text : textOf(result.reason ?? result.content),
    exitCode: payload.exitCode,
    capability: payload.effectiveCapability,
  };
}

// `mcp.call` 这个名字对人不说明任何事：判定链、审批框与记录里读的都是 `mcp:<服务器>/<工具>`，画出来的也该是那一串。
export function capabilityOf(name, args) {
  if (name === 'mcp.call' && typeof args?.server === 'string' && typeof args?.tool === 'string') return `mcp:${args.server}/${args.tool}`;
  return name;
}

// 一条记录画成一行或者几行：助手那一条可能带着若干次工具调用，工具调用与结果各占一行。
export function projectRecord(record) {
  // 人打的那一行原样画出来（D54）：展开后的那一份是给模型的，回看时要对得上当时敲了什么。
  if (record.kind === 'user') return [{ kind: 'question', text: record.raw ?? record.text }];
  if (record.kind === 'reasoning') return [{ kind: 'reasoning', text: record.text }];
  if (record.kind === 'assistant') {
    const rows = record.text === '' ? [] : [{ kind: 'answer', text: record.text }];
    for (const call of record.toolCalls ?? []) rows.push({ kind: 'call', tool: capabilityOf(call.name, call.args), text: JSON.stringify(call.args ?? {}) });
    return rows;
  }
  if (record.kind === 'tool') {
    const result = record.result ?? {};
    const kind = result.failed !== true ? 'result' : result.kind === 'refusal' ? 'refusal' : 'failure';
    const parts = resultParts(result);
    const row = { kind, tool: parts.capability ?? capabilityOf(record.tool, record.args), text: parts.text };
    if (result.code !== undefined) row.code = result.code;
    if (parts.exitCode !== undefined) row.exitCode = parts.exitCode;
    if (result.spilled !== undefined) row.spilled = result.spilled;
    return [row];
  }
  if (record.kind === 'mode') {
    // 模式生效是一件会改变模型能做什么的事，画在转录里，让人看得见是哪一条输入之后换的（I5）。
    return [{ kind: 'meta', text: `模式 ${record.name}（${MODE_LAYERS[record.layer] ?? record.layer}）生效：${record.tools.join('、')}` }];
  }
  return [];
}

// 状态行上的那一段上下文压力：当前投影的估算、窗口，外加越线没有（D82）。没写窗口时宿主交出 null，这一段整块不出现。
// 估算是本地量法乘上端点报回的修正系数，前面那个波浪号说的是它不是端点给的确数。
export function contextSegment(usage) {
  if (usage === null || usage === undefined) return '';
  return `ctx:~${usage.estimated}/${usage.window}${usage.estimated > usage.threshold ? ' 越线' : ''}`;
}

// 状态行里模式与判定档位各带一个前缀：`mode` 这一个词在界面上指过两样东西，写清楚比省字重要（D40）。
// 待生效写成 `mode:minimal→full`。宽度不够时先去掉工具数——它是模式与档位的推论，再挤就丢上下文那一段。
export function buildStatusLine({ head, sessionId, boundary, status, running, seconds, expanded, columns }) {
  const base = `${head}会话 ${sessionId.slice(0, 8)}${boundary === undefined ? '' : ` · ${boundary}`}`;
  if (status === null) return base;
  const context = contextSegment(status.usage);
  const parts = [`mode:${status.pendingMode === null ? status.mode ?? 'none' : `${status.mode}→${status.pendingMode}`}`,
    `policy:${status.policy}`];
  if (context !== '') parts.push(context);
  parts.push(`tools:${status.tools.length}`);
  const tail = `记录 ${status.eventCount} 条`
    + (running ? ` · ${Math.floor(seconds)} 秒，Esc 打断` : '')
    + (expanded ? ' · 已展开（Ctrl+O 收起）' : '');
  const line = (kept) => `${base} · ${kept.join('  ')} · ${tail}`;
  // 列数读不到时不裁：宁可让终端自己折行，也不要按一个猜的宽度丢东西。
  let shown = parts;
  if (columns !== undefined && columns > 0 && line(shown).length > columns) shown = shown.filter((part) => !part.startsWith('tools:'));
  if (columns !== undefined && columns > 0 && line(shown).length > columns) shown = shown.filter((part) => !part.startsWith('ctx:'));
  return line(shown);
}

// `/show` 要的是记录里那个稳定的序号，不是画面上的第几行：行会随投影变，序号不会（D40）。
export function findRecord(events, argument) {
  const seq = Number(argument);
  if (!Number.isInteger(seq) || seq < 0) return { code: 'tui_show_needs_a_number' };
  return { record: events.find((event) => event.seq === seq) ?? null };
}

// `/sub` 用的也是同一套序号，指向父记录里那条派生结果：支线会话 id 写在那一条的结果内容里（D71），
// 界面不猜文件名，也不为支线多要一次别的动作（D74）。
export function branchOf(record) {
  if (record?.kind !== 'tool' || record.tool !== 'subagent') return { code: 'tui_sub_needs_a_branch' };
  const sessionId = record.result?.content?.sessionId;
  // 结果内容超过注入上限时整段溢出到文件（I6），那一条记录里就没有 sessionId 这一格。
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { code: 'tui_sub_reference_spilled', spilled: record.result?.spilled };
  }
  return { sessionId };
}

// 那一格的标题先说清画的是哪一条线：主干与支线各有一套序号，混着看读出来的是错的因果（D74）。
export function detailTitle(detail) {
  if (detail.branch === undefined) return `记录 ${detail.seq}（${detail.kind}）的完整内容 · /show 收起`;
  return `支线 ${detail.branch}，父记录第 ${detail.seq} 那一次派生 · 这里的序号是支线自己的 · /sub 收起`;
}

// `/help` 那几行：界面命令、宿主交出来的提示模板、按键三组；宽度放不下就整组往下一层（D81）。
// 提示模板列在这里不是为了在界面里展开它——那一条命令真正跑的是 `run.start`，展开归宿主（D24、D49）。
export function helpLines(status, width) {
  const templates = status?.templates ?? [];
  const groups = [
    { title: '命令', entries: UI_COMMANDS.map((command) => ({ key: command.usage, action: command.text })) },
    {
      title: '提示模板',
      entries: templates.length === 0
        ? [{ key: '(没有)', action: '在 .ligule/prompts/ 或 ~/.ligule/prompts/ 下放一份 markdown' }]
        : templates.map((template) => ({ key: `/${template.command}`, action: template.description ?? '' })),
    },
    { title: '按键', entries: KEYS },
  ];
  return flowGroups(groups, width);
}

// 助手那一段是 markdown，看得见结构才算读得下去：标题加粗、列表带点、围栏里的内容原样且不加折行（第 41 步）。
// 代码行用 truncate-end 而不是 wrap：把一行代码折到第二行会让人以为那是两行代码。
function MarkdownRows({ text }) {
  return h(Fragment, null, markdownLines(text).map((line, index) => {
    if (line.kind === 'code') return h(Text, { key: index, wrap: 'truncate-end' }, `  ${line.text}`);
    if (line.kind === 'heading') return h(Text, { key: index, bold: true }, line.text);
    if (line.kind === 'list') return h(Text, { key: index, wrap: 'wrap' }, `· ${line.text}`);
    return h(Text, { key: index, wrap: 'wrap' }, line.text);
  }));
}

// 审批问的是「要不要做这一件」，那一句改动得先看得见：写入类工具的参数里带着全文或那两段，界面上算个行数就够。
export function changeSummary(tool, args) {
  const lines = (value) => String(value ?? '').split('\n').length;
  if ((tool === 'write' || tool === 'create') && typeof args?.content === 'string') return `${args.path ?? '?'}：${lines(args.content)} 行新内容`;
  if (tool === 'edit' && typeof args?.anchor === 'string') return `${args.path ?? '?'}：换掉 ${lines(args.anchor)} 行，换上 ${lines(args.replacement ?? '')} 行`;
  if (tool === 'delete') return `把 ${args.path ?? '?'} 移进回收站`;
  return '';
}

function Row({ row, expanded }) {
  if (row.kind === 'question') return h(Text, { color: 'cyan' }, `› ${row.text}`);
  if (row.kind === 'reasoning') {
    const folded = foldText(row.text, expanded, 1);
    return h(Fragment, null,
      h(Text, { dimColor: true, wrap: 'truncate-end' }, `· 推理 ${folded.shown}`),
      folded.hidden > 0 ? h(Text, { dimColor: true }, `  …还有 ${folded.hidden} 字推理，Ctrl+O 展开`) : null);
  }
  if (row.kind === 'answer') return h(MarkdownRows, { text: row.text });
  if (row.kind === 'call') return h(Text, { color: 'yellow' }, `→ ${row.tool} ${foldText(row.text, expanded, 1).shown}`);
  if (row.kind === 'result') {
    const folded = foldText(row.text, expanded);
    // 抬头那一行说的是这一件做成了什么：命令带退出码，溢出带那个文件名（I6 的那一条引用要看得见）。
    const note = [row.exitCode === undefined ? '' : `退出码 ${row.exitCode}`, row.spilled === undefined ? '' : `整段在 ${row.spilled}`].filter((part) => part !== '').join(' · ');
    return h(Fragment, null,
      h(Text, { color: 'green' }, `✓ ${row.tool}${note === '' ? '' : `（${note}）`}`),
      folded.shown === '' ? null : h(Text, { dimColor: true, wrap: 'truncate-end' }, folded.shown),
      folded.hidden > 0 ? h(Text, { dimColor: true }, `  …还有 ${folded.hidden} 字输出，Ctrl+O 展开`) : null);
  }
  if (row.kind === 'refusal') return h(Text, { color: 'magenta' }, `✗ ${row.tool} 没让做（${row.code}）`);
  if (row.kind === 'failure') return h(Text, { color: 'red' }, `✗ ${row.tool} ${row.code ?? ''} ${row.text}`);
  if (row.kind === 'meta') return h(Text, { dimColor: true }, `· ${row.text}`);
  return h(Text, { color: 'red' }, `! ${row.text}`);
}

// 队列里那一条画之前先裁短：一行装不下一整句话，而这一格的作用只是让人看见排了几条。
export function queuedLine(text, limit = 64) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function App({ client, sessionId: firstSessionId, info = {}, interactive = true, stdout, history = { entries: [], remember: async () => {} } }) {
  const app = useApp();
  const [sessionId, setSessionId] = useState(firstSessionId);
  const [rows, setRows] = useState([]);
  const [live, setLive] = useState({ text: '', reasoning: '' });
  const [ask, setAsk] = useState(null);
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  // 输入历史跨会话留住（D81 边界二：它存在界面自己那一份文件里，不进会话记录）。
  // 文件里的先后就是这里的先后，最新的排在第一个，上下键从第一个往下翻就是往旧处翻。
  const [entries, setEntries] = useState(history.entries);
  const [historyAt, setHistoryAt] = useState(-1);
  // Ctrl+R 那一次反查：查询串与移到第几条匹配；不在反查中时这一格是 null。
  const [search, setSearch] = useState(null);
  const [status, setStatus] = useState(null);
  // 详情画在动态区里：`Static` 不回画已提交的行，所以「看那一条」只能是把它再画一次（D39、D40）。
  const [detail, setDetail] = useState(null);
  // 斜杠输入时的选中位置：候选每次从草稿现算，这里只记住人移到第几条（D81）。
  const [pick, setPick] = useState(0);
  // Esc 收起候选时记下收起的是哪一段草稿：改一个字就该重新露出来，不需要另一个开关。
  const [dismissedAt, setDismissedAt] = useState(null);
  // 跑着的那一轮里回车排进来的那几条：只在界面一侧，不进记录也不进内核（D81 边界二）。
  const [queue, setQueue] = useState([]);

  const push = useCallback((...added) => setRows((current) => [...current, ...added]), []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await client.request('status.get', { sessionId }));
    } catch {
      // 状态读不到不影响这一轮本身，底部那一行留着上一次的读数。
    }
  }, [client, sessionId]);

  useEffect(() => {
    const onNotification = (message) => {
      if (message.sessionId !== sessionId) return;
      if (message.notify === 'delta') {
        const piece = message.event?.text ?? '';
        if (message.event?.type === 'text') setLive((current) => ({ ...current, text: current.text + piece }));
        else if (message.event?.type === 'reasoning') setLive((current) => ({ ...current, reasoning: current.reasoning + piece }));
        return;
      }
      if (message.notify === 'event') {
        // 刚落盘的那一条取代流式期间的那半截：记录是事实源（I5），界面按它重画。
        if (message.event?.kind === 'assistant') setLive((current) => ({ ...current, text: '' }));
        if (message.event?.kind === 'reasoning') setLive((current) => ({ ...current, reasoning: '' }));
        push(...projectRecord(message.event));
        return;
      }
      if (message.notify === 'fault') push({ kind: 'error', text: `${message.code}：${message.detail ?? ''}` });
    };
    const onRequest = (message) => {
      if (message.method !== 'approval.request' || message.params.sessionId !== sessionId) return;
      const args = message.params.args ?? {};
      // 画出来的那一行说的是什么对象：命令文本、路径、目标地址，或者那一项 MCP 能力名。
      // 写入类的参数里带着整份文件内容，那一段不进这一行——行数写在下面那一行里，全文走 `/show`。
      const shown = message.params.command ?? args.path ?? args.url ?? (typeof args.server === 'string' ? `mcp:${args.server}/${args.tool ?? ''}` : '');
      setAsk({
        id: message.id,
        tool: message.params.tool,
        detail: shown === '' ? JSON.stringify(args) : String(shown),
        change: changeSummary(message.params.tool, args),
        reason: message.params.reason ?? '',
        // 用哪一种语法判的、跑的是哪一个可执行文件：答的是这一条命令，看得见的该是这两样（D59）。
        backend: message.params.shell === undefined ? '' : `${message.params.shell} · ${message.params.executable ?? ''}`,
      });
    };
    client.onNotification(onNotification);
    client.onRequest(onRequest);
    void refreshStatus();
  }, [client, push, refreshStatus, sessionId]);

  // 跑着的时候走一个计时器：一格转圈、一秒一格，Esc 能打断这件事要看得见。
  useEffect(() => {
    if (!running) {
      setSeconds(0);
      return undefined;
    }
    const timer = setInterval(() => {
      setTick((current) => current + 1);
      setSeconds((current) => current + 0.2);
    }, 200);
    return () => clearInterval(timer);
  }, [running]);

  const submit = useCallback(async (text) => {
    // 发出去的那一句才进历史：排进队列的那几条等真正发出去时各自进一次，翻历史看到的都是真说过的话。
    setEntries((current) => pushHistory(current, text));
    void history.remember(text);
    setRunning(true);
    try {
      const result = await client.request('run.start', { sessionId, input: text });
      const extra = result.completedBy === undefined ? '' : `，由 ${result.completedBy} 收尾`;
      push({ kind: 'meta', text: `本轮结束：${result.iterations} 次迭代、${result.modelCalls} 次模型调用${extra}` });
    } catch (error) {
      const code = error.code ?? 'run_failed';
      if (code === 'loop_cancelled') push({ kind: 'meta', text: '这一轮已被打断' });
      else push({ kind: 'error', text: `${code}：${error.detail ?? error.message ?? ''}` });
    } finally {
      setAsk(null);
      setRunning(false);
      void refreshStatus();
    }
  }, [client, history, push, refreshStatus, sessionId]);

  // 命令一律收到第一个词，后面的整段作为参数交进来（/mode 要用）。
  const runCommand = useCallback((name, argument = '') => {
    if (name === 'quit') {
      app.exit();
      return;
    }
    if (name === 'new') {
      void (async () => {
        try {
          const created = await client.request('session.create', {});
          setSessionId(created.sessionId);
          setRows([]);
          setLive({ text: '', reasoning: '' });
          push({ kind: 'meta', text: `新会话 ${created.sessionId.slice(0, 8)}` });
        } catch (error) {
          push({ kind: 'error', text: `会话开不出来：${error.code ?? error.message}` });
        }
      })();
      return;
    }
    if (name === 'sessions') {
      void (async () => {
        // 列表来自宿主扫的那一份目录（第 34 步那个扫描器）：界面不去开盘，事实源仍然只有那一份（D81 边界一）。
        const listed = await client.request('sessions.list', { projectRoot: info.boundary, limit: SESSION_ROWS }).catch((error) => error);
        if (listed.code !== undefined) {
          push({ kind: 'error', text: `会话列不出来：${listed.code}${listed.detail === undefined ? '' : ` · ${listed.detail}`}` });
          return;
        }
        push({ kind: 'meta', text: sessionLines(listed.sessions, sessionId).join('\n') });
      })();
      return;
    }
    if (name === 'resume') {
      if (argument === '') {
        push({ kind: 'error', text: '/resume 后面要跟一个会话 id（/sessions 里那一串，写开头几段就行）' });
        return;
      }
      // 第二个词是那一份模式清单的名字：摘要变了时 D78 要一次显式的选择，界面上没有 `--mode` 这一格，
      // 这个位置就是它的等价物——否则那一次拒绝在终端里没有任何走下去的路。
      const [wanted, chosenMode] = argument.split(/\s+/);
      void (async () => {
        const listed = await client.request('sessions.list', { projectRoot: info.boundary }).catch((error) => error);
        if (listed.code !== undefined) {
          push({ kind: 'error', text: `会话列不出来：${listed.code}` });
          return;
        }
        const picked = resolveSessionId(wanted, listed.sessions);
        if (picked.id === undefined) {
          push({ kind: 'error', text: picked.code === 'tui_session_ambiguous'
            ? `以 ${wanted} 开头的有好几份，id 多写几段（/sessions 看列表）`
            : `${wanted} 在这个项目根跑过的会话里对不上任何一份（/sessions 看列表）` });
          return;
        }
        if (picked.id === sessionId) {
          push({ kind: 'meta', text: '当前就在这一份上，不用接' });
          return;
        }
        // 打开那一份记录时宿主会先补没人回答的派发，再按记录里最后生效的模式清单装配（D72、D78）。
        const opened = await client.request('session.open', { sessionId: picked.id, ...(chosenMode === undefined ? {} : { mode: chosenMode }) })
          .catch((error) => error);
        if (opened.code !== undefined) {
          push({ kind: 'error', text: `接不上：${opened.code}${opened.detail === undefined ? '' : ` · ${opened.detail}`}`
            + (opened.code === 'resume_mode_changed' ? `；指名一份再来一次：/resume ${wanted} <模式名>` : '') });
          return;
        }
        const read = await client.request('session.read', { sessionId: picked.id }).catch((error) => error);
        if (read.code !== undefined) {
          push({ kind: 'error', text: `接上了但记录读不回来：${read.code}` });
          return;
        }
        setSessionId(picked.id);
        // 投影从那份记录重建，而不是接着画：换过来的这一份里发生过什么，只有记录说得出（I5）。
        setRows(read.events.flatMap((event) => projectRecord(event)));
        setLive({ text: '', reasoning: '' });
        setDetail(null);
        const row = listed.sessions.find((item) => item.id === picked.id);
        push({
          kind: 'meta',
          text: `接上会话 ${picked.id.slice(0, 8)}：${read.events.length} 条记录画在下方`
            + (row === undefined || row.unanswered === 0 ? '' : `；崩溃留下的 ${row.unanswered} 次派发补成了未知结果`),
        });
      })();
      return;
    }
    if (name === 'tools') {
      void (async () => {
        const current = await client.request('status.get', { sessionId }).catch(() => null);
        setStatus(current);
        push({ kind: 'meta', text: current === null ? '状态读不到' : `工具：${current.tools.join('、')}` });
      })();
      return;
    }
    if (name === 'status') {
      void (async () => {
        const current = await client.request('status.get', { sessionId }).catch(() => null);
        setStatus(current);
        const context = contextSegment(current?.usage);
        push({ kind: 'meta', text: current === null ? '状态读不到'
          : `模式 ${current.mode ?? '没装'} · 档位 ${current.policy} · 拒绝 连续 ${current.denials.consecutive} 次 / 累计 ${current.denials.total} 次 · 记录 ${current.eventCount} 条`
            + (context === '' ? '' : ` · ${context}`) });
      })();
      return;
    }
    if (name === 'compact') {
      void (async () => {
        // 压这一件事归宿主：要调模型、要写检查点（D83）。界面只把结果说清楚，包括三种不肯压的情况。
        const done = await client.request('session.compact', { sessionId }).catch((error) => error);
        if (done.code !== undefined) {
          push({ kind: 'error', text: `压不成：${done.code}${done.detail === undefined ? '' : ` · ${done.detail}`}` });
          return;
        }
        setStatus(await client.request('status.get', { sessionId }).catch(() => null));
        push({
          kind: 'meta',
          text: `压掉了第 ${done.fromSeq} 到 ${done.toSeq} 条：投影从约 ${done.tokensBefore} 变成约 ${done.tokensAfter}（本地量法），原文仍在记录里`,
        });
      })();
      return;
    }
    if (name === 'mode') {
      void (async () => {
        // 带名字就是一次切换请求，不带名字只是问一句现在用的是哪一份（D41）。
        if (argument === '') {
          const current = await client.request('status.get', { sessionId }).catch(() => null);
          setStatus(current);
          push({ kind: 'meta', text: current === null || current.mode === null ? '模式读不到'
            : `当前 ${current.mode}${current.pendingMode === null ? '' : `，下一个 ${current.pendingMode}（待生效）`}` });
          return;
        }
        const switched = await client.request('mode.set', { sessionId, name: argument }).catch((error) => error);
        if (switched.code !== undefined) {
          push({ kind: 'error', text: `切不过去：${switched.code}${switched.detail === undefined ? '' : ` · ${switched.detail}`}` });
          return;
        }
        setStatus(await client.request('status.get', { sessionId }).catch(() => null));
        push({ kind: 'meta', text: switched.pending === null
          ? `模式切到 ${switched.mode}（${switched.tools.length} 件工具）`
          : `已请求切到 ${switched.pending}，这一轮结束才生效；再打一次 /mode ${switched.mode} 可以撤回` });
      })();
      return;
    }
    if (name === 'show') {
      void (async () => {
        if (argument === '') {
          setDetail(null);
          return;
        }
        const read = await client.request('session.read', { sessionId }).catch((error) => error);
        if (read.code !== undefined) {
          push({ kind: 'error', text: `记录读不回来：${read.code}` });
          return;
        }
        const picked = findRecord(read.events, argument);
        if (picked.code !== undefined) {
          push({ kind: 'error', text: '/show 后面要一个记录序号（会话记录里的第几条，不是画面上的第几行）' });
          return;
        }
        if (picked.record === null) {
          push({ kind: 'error', text: `记录里没有第 ${argument} 条（现有 ${read.events.length} 条，编号从 0 起）` });
          return;
        }
        setDetail({ seq: picked.record.seq, kind: picked.record.kind, rows: projectRecord(picked.record) });
      })();
      return;
    }
    if (name === 'sub') {
      void (async () => {
        if (argument === '') {
          setDetail(null);
          return;
        }
        const parent = await client.request('session.read', { sessionId }).catch((error) => error);
        if (parent.code !== undefined) {
          push({ kind: 'error', text: `记录读不回来：${parent.code}` });
          return;
        }
        const picked = findRecord(parent.events, argument);
        if (picked.code !== undefined) {
          push({ kind: 'error', text: '/sub 后面要一个记录序号（父记录里那条 subagent 结果的序号）' });
          return;
        }
        if (picked.record === null) {
          push({ kind: 'error', text: `记录里没有第 ${argument} 条（现有 ${parent.events.length} 条，编号从 0 起）` });
          return;
        }
        const branch = branchOf(picked.record);
        if (branch.code === 'tui_sub_needs_a_branch') {
          push({ kind: 'error', text: `第 ${argument} 条不是一次派生执行的结果（要的是 subagent 那一条）` });
          return;
        }
        if (branch.code === 'tui_sub_reference_spilled') {
          push({ kind: 'error', text: `那一次派生的结果内容溢出在 ${branch.spilled ?? '文件里'}，记录里没有支线 id` });
          return;
        }
        // 支线那份走的是同一次读记录的动作：它不在这轮的内核里，但它是同一目录下的另一份会话记录（D74）。
        const read = await client.request('session.read', { sessionId: branch.sessionId }).catch((error) => error);
        if (read.code !== undefined) {
          push({ kind: 'error', text: `支线记录读不回来：${read.code}` });
          return;
        }
        setDetail({
          seq: picked.record.seq,
          kind: 'subagent',
          branch: branch.sessionId,
          rows: read.events.flatMap((event) => projectRecord(event)),
        });
      })();
      return;
    }
    if (name === 'help') {
      push({ kind: 'meta', text: helpLines(status, stdout?.columns ?? 80).join('\n') });
      return;
    }
    push({ kind: 'error', text: `没有这条命令：/${name}（/help 看列表）` });
  }, [app, client, info, push, sessionId, status, stdout]);

  const send = useCallback((text) => {
    const route = routeInput(text, running);
    setDraft('');
    setCaret(0);
    setHistoryAt(-1);
    setPick(0);
    setDismissedAt(null);
    if (route.kind === 'blocked') {
      push({ kind: 'meta', text: `这一轮跑着的时候 ${route.usage} 用不了；Esc 先打断这一轮` });
      return;
    }
    // 跑着的那一轮里，要交给模型的那一句进队列：这一轮结束后按先后发出，回车不再是吞掉一句话。
    if (route.kind === 'run' && running) {
      setQueue((current) => [...current, route.text]);
      return;
    }
    if (route.kind === 'command') {
      push({ kind: 'meta', text: findUiCommand(route.name).usage });
      runCommand(route.name, route.argument);
      return;
    }
    void submit(route.text);
  }, [push, runCommand, running, submit]);

  // 本轮结束后把队列里的第一条发出去：一次只发一条，剩下的接着排；被打断也算这一轮结束（D20）。
  useEffect(() => {
    if (running || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void submit(next);
  }, [queue, running, submit]);

  // 候选每次从当前草稿算出来：草稿改一个字清单就跟着变，不需要再维护一份状态（D81）。
  const templates = status?.templates ?? [];
  const picks = dismissedAt === draft || search !== null ? [] : candidatesOf(draft, templates);
  const chosen = picks.length === 0 ? 0 : Math.min(pick, picks.length - 1);
  const searched = search === null ? [] : searchHistory(entries, search.query);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      app.exit();
      return;
    }
    if (key.ctrl && input === 'o') {
      setExpanded((current) => !current);
      return;
    }
    // Ctrl+G 把草稿交给外面那一份编辑器：这一段文本走一份临时文件，回来的是它写回的那一份。
    // 让出终端这件事归 Ink（raw mode 与重画都在它手里），否则编辑器与界面抢同一把输入。
    if (key.ctrl && input === 'g') {
      if (info.editor === undefined || info.editor === '') {
        push({ kind: 'error', text: '没有 EDITOR 这一格，界面不猜哪一个编辑器能用；设好它再来一次 Ctrl+G' });
        return;
      }
      void (async () => {
        let outcome = { code: 'tui_editor_failed' };
        await app.suspendTerminal(async () => {
          outcome = await editInExternalEditor(info.editor, draft);
        });
        if (outcome.text === undefined) {
          push({ kind: 'error', text: `编辑没成：${outcome.code}` });
          return;
        }
        setDraft(outcome.text);
        setCaret(outcome.text.length);
      })();
      return;
    }
    if (key.ctrl && input === 'r' && search === null) {
      // 起一次反查：查询串从空开始，接着打的每个字符都往它后面加。
      setSearch({ query: '', at: 0 });
      return;
    }
    if (search !== null) {
      const found = searchHistory(entries, search.query);
      const cycle = (step) => setSearch(found.length === 0 ? search : { ...search, at: (search.at + step + found.length) % found.length });
      if (key.escape) {
        setSearch(null);
        return;
      }
      if (key.return) {
        const picked = found[search.at];
        if (picked !== undefined) {
          setDraft(picked);
          setCaret(picked.length);
        }
        setSearch(null);
        return;
      }
      if (key.upArrow || (key.ctrl && input === 'r')) {
        cycle(1);
        return;
      }
      if (key.downArrow) {
        cycle(-1);
        return;
      }
      if (key.backspace || key.delete) {
        // 查询串空着时再按退格就是退出反查，不是把空格当内容删。
        setSearch(search.query === '' ? null : { query: search.query.slice(0, -1), at: 0 });
        return;
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        setSearch({ query: search.query + input, at: 0 });
      }
      return;
    }
    if (ask !== null) {
      if (input === 'y' || input === 'Y') {
        const asked = ask;
        setAsk(null);
        push({ kind: 'meta', text: `已允许 ${asked.tool}` });
        client.reply(asked.id, { decision: 'allow' });
      } else if (input === 'n' || input === 'N') {
        const asked = ask;
        setAsk(null);
        push({ kind: 'meta', text: `已不允许 ${asked.tool}` });
        client.reply(asked.id, { decision: 'deny' });
      }
      return;
    }
    if (picks.length > 0) {
      if (key.tab) {
        const picked = picks[chosen];
        // 带参数提示的那一条补完留一个空格，光标落在要写参数的地方；不带的补完就能直接发。
        const completed = `/${picked.name}${picked.hint === '' ? '' : ' '}`;
        setDraft(completed);
        setCaret(completed.length);
        setPick(0);
        return;
      }
      if (key.upArrow || key.downArrow) {
        setPick(key.upArrow ? (chosen === 0 ? picks.length - 1 : chosen - 1) : (chosen + 1) % picks.length);
        return;
      }
      if (key.escape) {
        setDismissedAt(draft);
        return;
      }
    }
    if (key.escape) {
      if (running) void client.request('run.cancel', { sessionId }).catch((error) => push({ kind: 'error', text: error.code ?? 'run_cancel_failed' }));
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (entries.length === 0) return;
      // 只在单行草稿上翻历史：草稿里已经有换行时上下键留给光标。
      if (draft.includes('\n')) return;
      const next = key.upArrow ? Math.min(historyAt + 1, entries.length - 1) : Math.max(historyAt - 1, -1);
      setHistoryAt(next);
      const recalled = next < 0 ? '' : entries[next];
      setDraft(recalled);
      setCaret(recalled.length);
      return;
    }
    if ((key.backspace || key.delete) && draft === '' && queue.length > 0) {
      // 草稿已经空着时按退格，最后排进来的那一条收回草稿里：打错的那一句要能改，不必重新打一遍。
      setQueue((current) => current.slice(0, -1));
      const last = queue[queue.length - 1];
      setDraft(last);
      setCaret(last.length);
      return;
    }
    if (key.return) {
      if (key.shift) {
        const inserted = draft.slice(0, caret) + '\n' + draft.slice(caret);
        setDraft(inserted);
        setCaret(caret + 1);
        return;
      }
      if (draft.trim() !== '') send(draft);
      return;
    }
    const edited = editDraft(draft, caret, input, key);
    setDraft(edited.draft);
    setCaret(edited.caret);
  // 没有真终端时不开这一路：Ink 在拿不到 raw mode 的输入上是报错而不是降级（检查里就传 interactive: false）。
  }, { isActive: interactive });

  const head = info.model === undefined ? '' : `${info.model} · `;
  const foldedLive = foldText(live.reasoning, expanded, 1);

  return h(Fragment, null,
    // 一换会话就重画整份：`Static` 只补索引往后新增的行，接上来的那一份记录比当前这一份短时，
    // 不加这个 key 就一条都画不出来（第 44 步）。会话 id 正是这一串行的归属，拿它当 key 不用另记一个计数。
    h(Static, { key: sessionId, items: rows }, (row, index) => h(Box, { key: index, flexDirection: 'column' }, h(Row, { row, expanded }))),
    foldedLive.shown === '' ? null : h(Text, { dimColor: true, wrap: 'truncate-end' }, `· 推理 ${foldedLive.shown}${foldedLive.hidden > 0 ? ` …还有 ${foldedLive.hidden} 字` : ''}`),
    live.text === '' ? null : h(Text, { wrap: 'wrap' }, live.text),
    ask === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1 },
      h(Text, { bold: true }, `要执行 ${ask.tool}`),
      h(Text, { wrap: 'truncate-end' }, ask.detail),
      ask.change === '' ? null : h(Text, { dimColor: true }, ask.change),
      ask.backend === '' ? null : h(Text, { dimColor: true, wrap: 'truncate-end' }, `后端 ${ask.backend}`),
      ask.reason === '' ? null : h(Text, { dimColor: true }, ask.reason),
      h(Text, null, '按 y 允许一次，按 n 不允许')),
    detail === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
      h(Text, { dimColor: true }, detailTitle(detail)),
      detail.rows.length === 0
        ? h(Text, { dimColor: true }, '这一条没有可画的内容')
        : detail.rows.map((row, index) => h(Row, { key: index, row, expanded: true }))),
    queue.length === 0 ? null : h(Box, { flexDirection: 'column' },
      queue.map((item, index) => h(Text, { key: `${index}:${item}`, dimColor: true }, `排队 ${index + 1} · ${queuedLine(item)}`)),
      h(Text, { dimColor: true }, '  这一轮结束后按先后发出；草稿空着时按退格收回最后一条')),
    search === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'magenta', paddingX: 1 },
      h(Text, null, `反查 ${search.query}`),
      searched.length === 0
        ? h(Text, { dimColor: true }, entries.length === 0 ? '还没有发过任何一句' : `没有哪一句含「${search.query}」`)
        : searched.map((entry, index) => h(Box, { key: `${index}:${entry}` },
            h(Text, { inverse: index === search.at }, ` ${queuedLine(entry, 60)}`))),
      h(Text, { dimColor: true }, '  接着打字缩小 · Ctrl+R 或 ↑↓ 换一条 · Enter 填进草稿 · Esc 退出')),
    picks.length === 0 ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
      picks.slice(0, CANDIDATE_ROWS).map((candidate, index) => h(Box, { key: `${candidate.source}:${candidate.name}` },
        h(Text, { inverse: index === chosen }, ` /${candidate.name}${candidate.hint === '' ? '' : ` ${candidate.hint}`}`),
        h(Text, { dimColor: true }, ` ${candidate.text}`))),
      picks.length > CANDIDATE_ROWS ? h(Text, { dimColor: true }, `  还有 ${picks.length - CANDIDATE_ROWS} 条，接着打字就缩小了`) : null,
      h(Text, { dimColor: true }, ' Tab 补全 · ↑↓ 选 · Esc 收起')),
    h(Box, null,
      h(Text, { color: running ? 'yellow' : 'cyan' }, running ? `${SPINNER[tick % SPINNER.length]} ` : '› '),
      draft === '' && !running
        ? h(Text, { dimColor: true }, '要模型做的事（Enter 发送，Shift+Enter 换行，打 / 看清单）')
        : h(Fragment, null,
          h(Text, null, draft.slice(0, caret)),
          h(Text, { inverse: true }, draft[caret] ?? ' '),
          h(Text, null, draft.slice(caret + 1)))),
    h(Text, { dimColor: true }, buildStatusLine({
      head, sessionId, boundary: info.boundary, status, running, seconds, expanded, columns: stdout?.columns,
    })),
  );
}
