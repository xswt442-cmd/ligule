// 终端界面的行、输入与状态（D33 的第二种客户端）。这里不读帧也不写帧：帧由 src/host/connection.js 那一层交进来，
// 这一层只把会话记录与流式增量画成行，并把按键变成协议里的调用。
// 纯函数（editDraft、foldText、projectRecord、branchOf、detailTitle 与 commands.ts 里那几张表）都从这里交出去，
// 检查在 test/tui.test.js，不靠真终端也能验；画面本身跑 `ligule tui` 看。
import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { SESSION_ROWS, UI_COMMANDS, candidatesOf, findUiCommand, flowGroups, resolveSessionId, routeInput, sessionLines } from './commands.js';
import { pushHistory, searchHistory } from './history.js';
import { editInExternalEditor } from './editor.js';
import { copyToClipboard, lastAnswer } from './clipboard.js';
import { exportMarkdown, titleEscape, titleText, writeExport } from './output.js';
import { markdownLines } from './markdown.js';
import { selectedText, transcriptLines, viewportPosition, wrapLine } from './viewport.js';
import { displayWidth } from './commands.js';

const SPINNER = ['⠋', '⠙', '', '⠸', '⠼', '⠴', '⠦', '', '⠇', '⠏'];
const FOLD_LINES = 3;
// 模式来自哪一层，画给人看的是中文，记录里那三个名字与装载那一侧一致（D43）。
const MODE_LAYERS = { shipped: '随包', user: '全局', project: '项目' };
// 清单最多画几行：再长就把屏幕顶到输入框以外，人看不到自己在敲什么。
const CANDIDATE_ROWS = 6;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// 那几张表与那几个纯函数交给检查里用（test/tui.test.js），界面自己只走这一处出口。
export { SESSION_ROWS, UI_COMMANDS, candidatesOf, displayWidth, findUiCommand, flowGroups, resolveSessionId, routeInput, sessionLines } from './commands.js';
export { markdownLines } from './markdown.js';

// `/help` 画三组：界面命令、宿主交出来的提示模板、按键。前两组在这里只列名字与说明，展开与装载都不归界面。
const KEYS = [
  { key: 'Enter', action: '发送' },
  { key: 'Shift+Enter / Ctrl+N', action: '换行' },
  { key: 'Tab', action: '补全清单里选中的那一条' },
  { key: '↑ ↓', action: '在清单里选，清单不在时翻输入历史' },
  { key: 'Ctrl+R', action: '反查发过的那几句' },
  { key: 'Ctrl+G', action: '用 VISUAL 或 EDITOR 编辑草稿' },
  { key: 'Esc', action: '收起清单；跑着的时候打断这一轮' },
  { key: 'Ctrl+O', action: '打开或收起完整历史' },
  { key: 'PageUp/Down', action: '在历史浏览中分页，Home/End 到两端' },
  { key: 'Shift+↑↓', action: '在历史浏览中选择文字，Ctrl+Y 复制' },
  { key: 'Ctrl+C', action: '退出' },
];

// 草稿的编辑：左右移光标、Home/End 与 Ctrl+A/E 跳两端、Ctrl+W 删前一个词、Ctrl+U 清空、其余可打印字符插在光标处。
export function editDraft(draft, caret, input, key) {
  const boundaries = [...GRAPHEMES.segment(draft)].map((part) => part.index);
  const previous = boundaries.filter((index) => index < caret).at(-1) ?? 0;
  const next = boundaries.find((index) => index > caret) ?? draft.length;
  if (key.leftArrow) return { draft, caret: previous };
  if (key.rightArrow) return { draft, caret: next };
  if (key.home || (key.ctrl && input === 'a')) return { draft, caret: 0 };
  if (key.end || (key.ctrl && input === 'e')) return { draft, caret: draft.length };
  if (key.ctrl && input === 'u') return { draft: '', caret: 0 };
  if (key.ctrl && input === 'w') {
    // 先跳过光标前的空白，再删一个词：连着空白一起删会让「rm -rf  」整段消失。
    const head = draft.slice(0, caret).replace(/\s+$/, '').replace(/[\p{L}\p{N}_.\-/]+$/u, '');
    return { draft: head + draft.slice(caret), caret: head.length };
  }
  if (key.backspace || key.delete) {
    if (caret === 0) return { draft, caret };
    return { draft: draft.slice(0, previous) + draft.slice(caret), caret: previous };
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
  let base = `${head}会话 ${sessionId.slice(0, 8)}${boundary === undefined ? '' : ` · ${boundary}`}`;
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
  if (columns !== undefined && columns > 0 && displayWidth(line(shown)) > columns) shown = shown.filter((part) => !part.startsWith('tools:'));
  if (columns !== undefined && columns > 0 && displayWidth(line(shown)) > columns) shown = shown.filter((part) => !part.startsWith('ctx:'));
  if (columns !== undefined && columns > 0 && displayWidth(line(shown)) > columns) base = `${head}会话 ${sessionId.slice(0, 8)}`;
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

// 助手的 Markdown 按终端列数排版，代码按语言上色，内容完整保留。
function MarkdownRows({ text, columns = 80 }) {
  const lines = useMemo(() => markdownLines(text, columns), [text, columns]);
  return h(Fragment, null, lines.map((line, index) => {
    if (line.kind === 'code') return h(Text, { key: index, wrap: 'wrap' }, '  ', line.spans === undefined ? line.text : line.spans.map((span, part) => {
      const scope = span.scope?.split('.')[0];
      const color = { keyword: 'magenta', string: 'green', number: 'yellow', comment: 'gray', title: 'cyan', literal: 'yellow', built_in: 'cyan' }[scope];
      return h(Text, { key: part, color }, span.text);
    }));
    if (line.kind === 'heading') return h(Text, { key: index, bold: true }, line.text);
    if (line.kind === 'list') return h(Text, { key: index, wrap: 'wrap' }, line.text);
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

function Row({ row, expanded, columns }) {
  if (row.kind === 'question') return h(Text, { color: 'cyan' }, `› ${row.text}`);
  if (row.kind === 'reasoning') {
    const folded = foldText(row.text, expanded, 1);
    return h(Fragment, null,
      h(Text, { dimColor: true, wrap: 'truncate-end' }, `· 推理 ${folded.shown}`),
      folded.hidden > 0 ? h(Text, { dimColor: true }, `  …还有 ${folded.hidden} 字推理，Ctrl+O 展开`) : null);
  }
  if (row.kind === 'answer') return h(MarkdownRows, { text: row.text, columns });
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
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;
  const [geometry, setGeometry] = useState({ columns: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 });
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
  const [historyDraft, setHistoryDraft] = useState('');
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
  const [sessionPicker, setSessionPicker] = useState(null);
  const [approvalExpanded, setApprovalExpanded] = useState(false);
  const [approvalCursor, setApprovalCursor] = useState(0);

  const push = useCallback((...added) => setRows((current) => [...current, ...added]), []);

  const refreshStatus = useCallback(async () => {
    try {
      const current = await client.request('status.get', { sessionId });
      if (activeSession.current === sessionId) setStatus(current);
    } catch (error) {
      if (activeSession.current !== sessionId) return;
      setStatus(null);
      push({ kind: 'error', text: `状态读不回来：${error.code ?? error.message}` });
    }
  }, [client, push, sessionId]);

  useEffect(() => {
    const resize = () => setGeometry({ columns: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 });
    stdout?.on?.('resize', resize);
    return () => stdout?.off?.('resize', resize);
  }, [stdout]);

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
        push(...projectRecord(message.event).map((row) => ({ ...row, seq: message.event.seq })));
        return;
      }
      if (message.notify === 'fault') push({ kind: 'error', text: `${message.code}：${message.detail ?? ''}` });
    };
    const onRequest = (message) => {
      if (message.method !== 'approval.request' || message.params.sessionId !== sessionId) return;
      const args = message.params.args ?? {};
      setApprovalExpanded(false);
      setApprovalCursor(0);
      setDetail(null);
      setSessionPicker(null);
      setSearch(null);
      setExpanded(false);
      // 画出来的那一行说的是什么对象：命令文本、路径、目标地址，或者那一项 MCP 能力名。
      // 写入类的参数里带着整份文件内容，那一段不进这一行——行数写在下面那一行里，全文走 `/show`。
      const shown = message.params.command ?? args.path ?? args.url ?? (typeof args.server === 'string' ? `mcp:${args.server}/${args.tool ?? ''}` : '');
      setAsk({
        id: message.id,
        tool: message.params.tool,
        detail: shown === '' ? JSON.stringify(args) : String(shown),
        change: changeSummary(message.params.tool, args),
        reason: message.params.reason ?? '',
        content: message.params.tool === 'edit'
          ? `原内容：\n${args.anchor ?? ''}\n\n新内容：\n${args.replacement ?? ''}`
          : typeof args.content === 'string' ? args.content : JSON.stringify(args, null, 2),
        // 用哪一种语法判的、跑的是哪一个可执行文件：答的是这一条命令，看得见的该是这两样（D59）。
        backend: message.params.shell === undefined ? '' : `${message.params.shell} · ${message.params.executable ?? ''}`,
      });
    };
    client.onNotification(onNotification);
    client.onRequest(onRequest);
    void refreshStatus();
  }, [client, push, refreshStatus, sessionId]);

  // 终端标题画出模型、项目根与这一份会话：切会话时那一串跟着换，任务栏与窗口列表里就能认出是哪一份。
  // 没有真终端时不写：那串转义序列落在管道里会成为别人读到的字节。
  useEffect(() => {
    if (stdout?.isTTY !== true) return;
    stdout.write(titleEscape(titleText({ model: info.model, boundary: info.boundary, sessionId })));
  }, [info.boundary, info.model, sessionId, stdout]);

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

  const remember = useCallback((text) => {
    // 发出去的那一句才进历史：排进队列的那几条等真正发出去时各自进一次，翻历史看到的都是真说过的话。
    setEntries((current) => pushHistory(current, text));
    void history.remember(text).catch((error) => push({ kind: 'error', text: `输入历史保存失败：${error.code ?? error.message}` }));
  }, [history, push]);

  const submit = useCallback(async (text) => {
    remember(text);
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
  }, [client, push, refreshStatus, remember, sessionId]);

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
          setDetail(null);
          setSessionPicker(null);
          setRows([]);
          setLive({ text: '', reasoning: '' });
          push({ kind: 'meta', text: `新会话 ${created.sessionId.slice(0, 8)}` });
        } catch (error) {
          push({ kind: 'error', text: `会话开不出来：${error.code ?? error.message}` });
        }
      })();
      return;
    }
    if (name === 'copy') {
      void (async () => {
        // 复制的是记录里最后那一条回答：流式期间那半截还没落盘，复制它等于复制一份没成形的文本（I5）。
        const read = await client.request('session.read', { sessionId }).catch((error) => error);
        if (read.code !== undefined) {
          push({ kind: 'error', text: `记录读不回来：${read.code}` });
          return;
        }
        const answer = lastAnswer(read.events);
        if (answer === '') {
          push({ kind: 'meta', text: '这一份记录里还没有可复制的回答' });
          return;
        }
        const done = await copyToClipboard(answer);
        push(done.program === undefined
          ? { kind: 'error', text: `复制没成：${done.code}` }
          : { kind: 'meta', text: `最近那一条回答（${answer.length} 字）已放进剪贴板（${done.program}）` });
      })();
      return;
    }
    if (name === 'export') {
      if (argument === '') {
        push({ kind: 'error', text: '/export 后面要跟一个写到哪里的路径，例如 /export 笔记/这次运行.md' });
        return;
      }
      void (async () => {
        const read = await client.request('session.read', { sessionId, fullResults: true }).catch((error) => error);
        if (read.code !== undefined) {
          push({ kind: 'error', text: `记录读不回来：${read.code}` });
          return;
        }
        const header = read.header;
        const main = exportMarkdown(read.events, {
          id: sessionId,
          projectRoot: header?.projectRoot,
          createdAt: header?.createdAt ?? null,
        });
        // 支线那几份还是同一次读记录的动作（D74）：父记录里那条派生结果带着支线自己的 id。
        const branches = [];
        for (const event of read.events) {
          const branch = branchOf(event);
          if (branch.sessionId === undefined) continue;
          const branchRead = await client.request('session.read', { sessionId: branch.sessionId, fullResults: true }).catch((error) => error);
          if (branchRead.code !== undefined) {
            push({ kind: 'error', text: `支线 ${branch.sessionId} 读不回来：${branchRead.code}，那一份没写出去` });
            continue;
          }
          branches.push({ id: branch.sessionId, text: exportMarkdown(branchRead.events, { id: branch.sessionId, projectRoot: header?.projectRoot }) });
        }
        const written = await writeExport(argument, main, branches).catch((error) => error);
        if (written.code !== undefined) {
          push({ kind: 'error', text: `写不出去：${written.code ?? written.message}` });
          return;
        }
        push({ kind: 'meta', text: `已写出 ${written.length} 份文件：\n${written.join('\n')}` });
      })();
      return;
    }
    if (name === 'sessions') {
      void (async () => {
        // 列表来自宿主扫的那一份目录（第 34 步那个扫描器）：界面不去开盘，事实源仍然只有那一份（D81 边界一）。
        const listed = await client.request('sessions.list', { projectRoot: info.boundary }).catch((error) => error);
        if (listed.code !== undefined) {
          push({ kind: 'error', text: `会话列不出来：${listed.code}${listed.detail === undefined ? '' : ` · ${listed.detail}`}` });
          return;
        }
        if (listed.sessions.length === 0) push({ kind: 'meta', text: '这个项目根下还没有跑过的会话' });
        else {
          setDetail(null);
          setExpanded(false);
          setSearch(null);
          setSessionPicker({ items: listed.sessions, at: 0 });
        }
      })();
      return;
    }
    if (name === 'resume') {
      if (argument === '') {
        runCommand('sessions');
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
        if (picked.id === sessionId && chosenMode === undefined) {
          setSessionPicker(null);
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
        // 换走的那一份在宿主里还占着一次装配与那一份记录锁：终端一次只看一份会话，看走的那一份收掉（D85）。
        // 请求先发、答复后等：换会话 id 与换那一栏记录要在同一帧里落笔，`Static` 的 items 按索引决定补画哪几行，
        // 中间插一次 await 就把它拆成两帧，少画的那一段正是接过来的那一份记录。收不掉也不是接不上的理由，只在 meta 那一行说一句。
        const retiring = client.request('session.close', { sessionId }).catch((error) => error);
        setSessionId(picked.id);
        setSessionPicker(null);
        // 投影从那份记录重建，而不是接着画：换过来的这一份里发生过什么，只有记录说得出（I5）。
        setRows(read.events.flatMap((event) => projectRecord(event).map((row) => ({ ...row, seq: event.seq }))));
        setLive({ text: '', reasoning: '' });
        setDetail(null);
        const retired = await retiring;
        const row = listed.sessions.find((item) => item.id === picked.id);
        push({
          kind: 'meta',
          text: `接上会话 ${picked.id.slice(0, 8)}：${read.events.length} 条记录画在下方`
            + (retired.code === undefined ? '' : `；上一份没收掉：${retired.code}`)
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
        setRunning(true);
        try {
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
        } finally {
          setRunning(false);
        }
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
        const read = await client.request('session.read', { sessionId, fullResults: true }).catch((error) => error);
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
        const parent = await client.request('session.read', { sessionId, fullResults: true }).catch((error) => error);
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
        const read = await client.request('session.read', { sessionId: branch.sessionId, fullResults: true }).catch((error) => error);
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
    if (route.kind === 'blocked') {
      push({ kind: 'meta', text: `这一轮跑着的时候 ${route.usage} 用不了；Esc 先打断这一轮` });
      return;
    }
    setDraft('');
    setCaret(0);
    setHistoryAt(-1);
    setPick(0);
    setDismissedAt(null);
    // 跑着的那一轮里，要交给模型的那一句进队列：这一轮结束后按先后发出，回车不会把那一句丢掉。
    if (route.kind === 'run' && running) {
      setQueue((current) => [...current, route.text]);
      return;
    }
    if (route.kind === 'command') {
      remember(text);
      push({ kind: 'meta', text: findUiCommand(route.name).usage });
      runCommand(route.name, route.argument);
      return;
    }
    void submit(route.text);
  }, [push, remember, runCommand, running, submit]);

  // 本轮结束后把队列里的第一条发出去：一次只发一条，剩下的接着排；被打断也算这一轮结束（D20）。
  useEffect(() => {
    if (running || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void submit(next);
  }, [queue, running, submit]);

  // 候选每次从当前草稿算出来：草稿改一个字清单就跟着变，不需要再维护一份状态（D81）。
  const templates = status?.templates ?? [];
  const picks = dismissedAt === draft || search !== null || detail !== null || sessionPicker !== null || ask !== null ? [] : candidatesOf(draft, templates);
  const chosen = picks.length === 0 ? 0 : Math.min(pick, picks.length - 1);
  const searched = search === null ? [] : searchHistory(entries, search.query);
  const viewLines = useMemo(() => detail === null ? [] : transcriptLines(detail.rows, Math.max(1, geometry.columns - 6)), [detail?.rows, geometry.columns]);
  const viewHeight = Math.max(1, geometry.rows - 12 - (ask === null ? 0 : 7));
  const view = viewportPosition(detail?.cursor ?? 0, viewLines.length, viewHeight, detail?.offset ?? 0);
  const selection = detail?.anchor === undefined || detail.anchor === null ? [view.cursor, view.cursor] : [Math.min(detail.anchor, view.cursor), Math.max(detail.anchor, view.cursor)];
  const approvalLines = useMemo(() => ask === null ? [] : wrapLine(ask.content, Math.max(1, geometry.columns - 6)), [ask?.content, geometry.columns]);
  const approvalHeight = Math.max(1, geometry.rows - 12);
  const approvalView = viewportPosition(approvalCursor, approvalLines.length, approvalHeight);
  const caretText = useMemo(() => [...GRAPHEMES.segment(draft.slice(caret))][0]?.segment ?? ' ', [draft, caret]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      app.exit();
      return;
    }
    if (key.ctrl && input === 'o') {
      if (ask !== null) setApprovalExpanded((current) => !current);
      else {
        setSessionPicker(null);
        setSearch(null);
        setDetail(detail === null ? { seq: null, kind: 'transcript', rows: [], cursor: Number.MAX_SAFE_INTEGER, anchor: null, loading: true } : null);
        setExpanded(detail === null);
        if (detail === null) {
          void client.request('session.read', { sessionId, fullResults: true }).then((read) => {
            if (activeSession.current !== sessionId) return;
            const complete = read.events.flatMap((event) => projectRecord(event).map((row) => ({ ...row, seq: event.seq })));
            setDetail((current) => current?.kind === 'transcript' ? { ...current, rows: complete, loading: false } : current);
          }, (error) => push({ kind: 'error', text: `完整记录读不回来：${error.code ?? error.message}` }));
        }
      }
      return;
    }
    if (ask !== null && key.escape) {
      void client.request('run.cancel', { sessionId }).catch((error) => push({ kind: 'error', text: error.code ?? 'run_cancel_failed' }));
      return;
    }
    if (ask !== null && approvalExpanded) {
      const target = key.home ? 0 : key.end ? approvalLines.length - 1
        : key.pageUp ? approvalView.cursor - approvalHeight : key.pageDown ? approvalView.cursor + approvalHeight
          : key.upArrow ? approvalView.cursor - 1 : key.downArrow ? approvalView.cursor + 1 : null;
      if (target !== null) { setApprovalCursor(target); return; }
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
    if (detail !== null && ask === null) {
      if (key.escape) { setDetail(null); setExpanded(false); return; }
      if (key.ctrl && input === 'y') {
        void copyToClipboard(selectedText(viewLines, view.cursor, detail.anchor ?? null)).then((done) => {
          if (done.code !== undefined) push({ kind: 'error', text: `复制失败：${done.code}` });
        });
        return;
      }
      const target = key.home ? 0 : key.end ? viewLines.length - 1
        : key.pageUp ? view.cursor - viewHeight : key.pageDown ? view.cursor + viewHeight
          : key.upArrow ? view.cursor - 1 : key.downArrow ? view.cursor + 1 : null;
      if (target !== null) {
        const moved = viewportPosition(target, viewLines.length, viewHeight, view.offset);
        setDetail({ ...detail, ...moved, anchor: key.shift ? detail.anchor ?? view.cursor : null });
        return;
      }
      return;
    }
    if (sessionPicker !== null && ask === null) {
      if (key.escape) { setSessionPicker(null); return; }
      if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.home || key.end) {
        const step = key.pageUp ? -viewHeight : key.pageDown ? viewHeight : key.upArrow ? -1 : 1;
        const at = key.home ? 0 : key.end ? sessionPicker.items.length - 1 : Math.max(0, Math.min(sessionPicker.at + step, sessionPicker.items.length - 1));
        setSessionPicker({ ...sessionPicker, at });
        return;
      }
      if (key.return && draft === '') {
        if (running) push({ kind: 'meta', text: '当前轮次结束后才能切换会话' });
        else runCommand('resume', sessionPicker.items[sessionPicker.at].id);
        return;
      }
      if (input !== '' && !key.ctrl && !key.meta) setSessionPicker(null);
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
          push({ kind: 'error', text: `编辑没成：${outcome.code}${outcome.detail === undefined ? '' : ` · ${outcome.detail}`}` });
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
      if (draft.includes('\n')) {
        const start = draft.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
        const column = caret - start;
        if (key.upArrow && start > 0) {
          const previous = draft.lastIndexOf('\n', start - 2) + 1;
          setCaret(Math.min(previous + column, start - 1));
        } else if (key.downArrow) {
          const next = draft.indexOf('\n', caret);
          if (next >= 0) {
            const end = draft.indexOf('\n', next + 1);
            setCaret(Math.min(next + 1 + column, end < 0 ? draft.length : end));
          }
        }
        return;
      }
      if (entries.length === 0) return;
      if (historyAt === -1 && key.upArrow) setHistoryDraft(draft);
      const next = key.upArrow ? Math.min(historyAt + 1, entries.length - 1) : Math.max(historyAt - 1, -1);
      setHistoryAt(next);
      const recalled = next < 0 ? historyDraft : entries[next];
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
    if (key.return || (key.ctrl && input === 'n')) {
      if (key.shift || (key.ctrl && input === 'n')) {
        const inserted = draft.slice(0, caret) + '\n' + draft.slice(caret);
        setDraft(inserted);
        setCaret(caret + 1);
        return;
      }
      if (draft.trim() !== '') send(draft);
      return;
    }
    const edited = editDraft(draft, caret, input.replace(/\r\n?/g, '\n'), key);
    setDraft(edited.draft);
    setCaret(edited.caret);
  // 没有真终端时不开这一路：Ink 在拿不到 raw mode 的输入上是报错而不是降级（检查里就传 interactive: false）。
  }, { isActive: interactive });

  const head = info.model === undefined ? '' : `${info.model} · `;
  const foldedLive = foldText(live.reasoning, expanded, 1);

  return h(Fragment, null,
    // 一换会话就重画整份：`Static` 只补索引往后新增的行，接上来的那一份记录比当前这一份短时，
    // 不加这个 key 就一条都画不出来（第 44 步）。会话 id 正是这一串行的归属，拿它当 key 不用另记一个计数。
    h(Static, { key: sessionId, items: rows }, (row, index) => h(Box, { key: index, flexDirection: 'column' }, h(Row, { row, expanded: false, columns: geometry.columns }))),
    foldedLive.shown === '' ? null : h(Text, { dimColor: true, wrap: 'truncate-end' }, `· 推理 ${foldedLive.shown}${foldedLive.hidden > 0 ? ` …还有 ${foldedLive.hidden} 字` : ''}`),
    live.text === '' || detail !== null ? null : h(MarkdownRows, { text: live.text, columns: geometry.columns }),
    ask === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1 },
      h(Text, { bold: true }, `要执行 ${ask.tool}`),
      h(Text, { wrap: 'truncate-end' }, ask.detail),
      ask.change === '' ? null : h(Text, { dimColor: true }, ask.change),
      ask.backend === '' ? null : h(Text, { dimColor: true, wrap: 'truncate-end' }, `后端 ${ask.backend}`),
      ask.reason === '' ? null : h(Text, { dimColor: true, wrap: 'truncate-end' }, ask.reason),
      approvalExpanded ? h(Fragment, null,
        ...approvalLines.slice(approvalView.offset, approvalView.offset + approvalHeight).map((line, index) => h(Text, { key: index, wrap: 'truncate-end' }, line)),
        h(Text, { dimColor: true }, `改动第 ${approvalView.cursor + 1}/${approvalLines.length} 行 · PageUp/Down 查看 · Home/End 到两端`)) : null,
      h(Text, { wrap: 'truncate-end' }, '按 y 允许一次，按 n 不允许 · Ctrl+O 查看改动 · Esc 打断')),
    detail === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
      h(Text, { dimColor: true, wrap: 'truncate-end' }, detail.kind === 'transcript' ? '会话完整历史' : detailTitle(detail)),
      viewLines.length === 0
        ? h(Text, { dimColor: true }, detail.loading ? '正在读取完整记录…' : '这一条没有可画的内容')
        : viewLines.slice(view.offset, view.offset + viewHeight).map((line, index) => h(Text, { key: view.offset + index, inverse: view.offset + index >= selection[0] && view.offset + index <= selection[1], wrap: 'truncate-end' }, line)),
      h(Text, { dimColor: true, wrap: 'truncate-end' }, `第 ${view.cursor + 1}/${viewLines.length} 行 · PageUp/Down 分页 · Home/End 到两端 · Shift+↑↓ 选择 · Ctrl+Y 复制 · Esc 收起`)),
    sessionPicker === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
      h(Text, { wrap: 'truncate-end' }, `历史会话 ${sessionPicker.items.length} 份 · ↑↓ 选择 · Enter 接上 · Esc 收起`),
      sessionPicker.items.slice(Math.max(0, sessionPicker.at - viewHeight + 1), Math.max(0, sessionPicker.at - viewHeight + 1) + viewHeight).map((item) => h(Text, { key: item.id, inverse: item === sessionPicker.items[sessionPicker.at], wrap: 'truncate-end' }, sessionLines([item], sessionId)[0]))),
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
      picks.slice(Math.max(0, chosen - CANDIDATE_ROWS + 1), Math.max(0, chosen - CANDIDATE_ROWS + 1) + CANDIDATE_ROWS).map((candidate) => h(Box, { key: `${candidate.source}:${candidate.name}` },
        h(Text, { inverse: candidate === picks[chosen] }, ` /${candidate.name}${candidate.hint === '' ? '' : ` ${candidate.hint}`}`),
        h(Text, { dimColor: true }, ` ${candidate.text}`))),
      picks.length > CANDIDATE_ROWS ? h(Text, { dimColor: true }, `  还有 ${picks.length - CANDIDATE_ROWS} 条，接着打字就缩小了`) : null,
      h(Text, { dimColor: true }, ' Tab 补全 · ↑↓ 选 · Esc 收起')),
    h(Box, null,
      h(Text, { color: running ? 'yellow' : 'cyan' }, running ? `${SPINNER[tick % SPINNER.length]} ` : '› '),
      draft === '' && !running
        ? h(Text, { dimColor: true }, '要模型做的事（Enter 发送，Shift+Enter 换行，打 / 看清单）')
        : h(Text, { wrap: 'wrap' },
          draft.slice(0, caret),
          h(Text, { inverse: true }, caretText),
          draft.slice(caret + (caret === draft.length ? 0 : caretText.length)))),
    h(Text, { dimColor: true, wrap: 'truncate-end' }, buildStatusLine({
      head, sessionId, boundary: info.boundary, status, running, seconds, expanded, columns: stdout?.columns,
    })),
  );
}
