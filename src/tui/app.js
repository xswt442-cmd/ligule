// 终端界面的行、输入与状态（D33 的第二种客户端）。这里不读帧也不写帧：帧由 src/host/connection.js 那一层交进来，
// 这一层只把会话记录与流式增量画成行，并把按键变成协议里的调用。
// 纯函数（editDraft、foldText、projectRecord、branchOf、detailTitle 与 commands.ts 里那几张表）都从这里交出去，
// 检查在 test/tui.test.js，不靠真终端也能验；画面本身跑 `ligule tui` 看。
import { resolve } from 'node:path';
import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, usePaste } from 'ink';
import { SESSION_ROWS, UI_COMMANDS, answerOf, candidatesOf, describeChange, findLines, findUiCommand, flowGroups, insertMention, mentionToken, resolveSessionId, routeInput, sessionLines } from './commands.js';
import { pushHistory, searchHistory } from './history.js';
import { editInExternalEditor } from './editor.js';
import { copyToClipboard, lastAnswer } from './clipboard.js';
import { titleEscape, titleText } from './output.js';
import { markdownLines } from './markdown.js';
import { selectedText, transcriptLines, viewportPosition, wrapLine } from './viewport.js';
import { CURRENT, KEYMAP, applyOverrides, conflictsIn, defaultSpecs, formatKeys, hit, keyHint, parseSpec } from './keymap.js';
import { displayWidth } from './commands.js';

const SPINNER = ['⠋', '⠙', '', '⠸', '⠼', '⠴', '⠦', '', '⠇', '⠏'];
const FOLD_LINES = 3;
// 模式来自哪一层，画给人看的是中文，记录里那三个名字与装载那一侧一致（D43）。
const MODE_LAYERS = { shipped: '随包', user: '全局', project: '项目' };
// 清单最多画几行：再长就把屏幕顶到输入框以外，人看不到自己在敲什么。
const CANDIDATE_ROWS = 6;
// 路径候选一次问宿主 8 条：这一处画的是文件名，多几行也读不完，而宿主的 `limit` 比它更宽。
const MENTION_ROWS = 8;
// 「没在问哪一段」的形状：真实的落笔处起点不可能是 -1，所以它跟任何一段都对不上。
const NO_TOKEN = { start: -1, text: '' };
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// 那几张表与那几个纯函数交给检查里用（test/tui.test.js），界面自己只走这一处出口。
export { SESSION_ROWS, UI_COMMANDS, answerOf, candidatesOf, describeChange, displayWidth, findLines, findUiCommand, flowGroups, insertMention, mentionToken, resolveSessionId, routeInput, sessionLines } from './commands.js';
export { KEYMAP, CURRENT, applyOverrides, conflictsIn, defaultSpecs, formatKeys, hit, keyHint, parseSpec, specOf } from './keymap.js';
export { markdownLines } from './markdown.js';

// `/help` 里那一组按键读的是 `keymap.ts` 那一份表：画面说出的键、动作与按键落的事从同一处取（方案 6.1）。
// 别名那几条不单列（`-alt`、`-shift` 结尾的那一些与另一记键落的是同一件事），一份清单不说两遍。
// 这一处是现算而不是模块加载时算一次：个人覆盖落进来之后，清单要说的是换过的键。
const keyRows = () => Object.entries(KEYMAP)
  .filter(([action]) => !/-alt$|-shift$/.test(action))
  .map(([action, binding]) => ({ key: formatKeys(CURRENT[action]), action: `${binding.label}（${binding.view}）` }));

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

// 撤销的「一个单位」怎么划：连着在末尾打出来的字算一个单位，退格、删词、粘贴、换行各算一个（方案 6.1）。
// 划线段的判据只有这一个：前一份是后一份的开头、多出来的正好是一个字素、那一头落在末尾、且不是空白。
// 空白单独成一段，打错「两个字之间的那个空格」时能退回打空格之前，而不是整句一起没。
export function isTypingRun(before, after) {
  if (before.caret !== before.draft.length || after.caret !== after.draft.length) return false;
  if (!after.draft.startsWith(before.draft)) return false;
  const parts = [...GRAPHEMES.segment(after.draft.slice(before.draft.length))];
  return parts.length === 1 && !/\s/u.test(parts[0].segment);
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
  if (record.kind === 'label') {
    // 名字与归档是这份会话自己的事实，改在哪一条输入之后要看得见（I5、实现顺序第 75 步）。
    const parts = [];
    if (typeof record.name === 'string') parts.push(`名字改成「${record.name}」`);
    if (typeof record.archived === 'boolean') parts.push(record.archived ? '这一份归档了' : '这一份不再归档');
    return parts.length === 0 ? [] : [{ kind: 'meta', text: parts.join('，') }];
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
// 待生效写成 `mode:minimal→full`。宽度不够时按「这一段能不能从别处再读到」退让：先把那一段最长的路径缩成最后一级目录名（认得出是哪一项目），
// 再去工具数与上下文那两段，然后丢模型名、丢整段路径，最后才动记录条数——跑着那一轮的打断提示不能被挤掉，
// 排在后面的那一段要为核心那几句留出固定的位置。
export function buildStatusLine({ head, sessionId, boundary, status, running, seconds, expanded, columns }) {
  const id = `会话 ${sessionId.slice(0, 8)}`;
  const root = boundary === undefined ? '' : boundary;
  let base = `${head}${id}${root === '' ? '' : ` · ${root}`}`;
  if (status === null) return base;
  const context = contextSegment(status.usage);
  const parts = [`mode:${status.pendingMode === null ? status.mode ?? 'none' : `${status.mode}→${status.pendingMode}`}`,
    `policy:${status.policy}${status.policySource === 'session' ? '(会话)' : ''}`];
  if (context !== '') parts.push(context);
  parts.push(`tools:${status.tools.length}`);
  // 打断与展开那两句跟在条数之后：挤的时候条数先走，这两句留着。
  const hints = (running ? ` · ${Math.floor(seconds)} 秒，${keyHint('interrupt')} 打断` : '')
    + (expanded ? ` · 已展开（${keyHint('expand-or-history')} 收起）` : '');
  let tail = `记录 ${status.eventCount} 条${hints}`;
  let shown = parts;
  // 列数读不到时不裁：宁可让终端自己折行，也不要按一个猜的宽度丢东西。
  const line = () => `${base} · ${shown.join('  ')}${tail === '' ? '' : ` · ${tail}`}`;
  const over = () => columns !== undefined && columns > 0 && displayWidth(line()) > columns;
  const leaf = root === '' ? '' : root.split(/[\\/]/).filter(Boolean).pop() ?? '';
  if (over()) base = `${head}${id}${leaf === '' ? '' : ` · ${leaf}`}`;
  if (over()) shown = shown.filter((part) => !part.startsWith('tools:'));
  if (over()) shown = shown.filter((part) => !part.startsWith('ctx:'));
  if (over()) base = `${id}${leaf === '' ? '' : ` · ${leaf}`}`;
  if (over()) base = id;
  if (over()) tail = hints === '' ? '' : hints.slice(3);
  return line();
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
    { title: '按键', entries: keyRows() },
  ];
  return flowGroups(groups, width);
}

// 助手的 Markdown 按终端列数排版，代码按语言上色，内容完整保留。
// 强调那几种记号（加粗、斜体、删除线、行内代码）在这一层画出来：范围名到 Ink 那几格的对应只有这一处（第 96 步）。
const MARK_STYLES = {
  'md-strong': { bold: true },
  'md-em': { italic: true },
  'md-del': { strikethrough: true },
  'md-codespan': { color: 'cyan' },
};
function MarkdownRows({ text, columns = 80 }) {
  const lines = useMemo(() => markdownLines(text, columns), [text, columns]);
  const marked = (line) => line.spans.map((span, part) => h(Text, { key: part, ...(MARK_STYLES[span.scope] ?? {}) }, span.text));
  return h(Fragment, null, lines.map((line, index) => {
    if (line.kind === 'code') return h(Text, { key: index, wrap: 'wrap' }, '  ', line.spans === undefined ? line.text : line.spans.map((span, part) => {
      const scope = span.scope?.split('.')[0];
      const color = { keyword: 'magenta', string: 'green', number: 'yellow', comment: 'gray', title: 'cyan', literal: 'yellow', built_in: 'cyan' }[scope];
      return h(Text, { key: part, color }, span.text);
    }));
    if (line.kind === 'heading') return h(Text, { key: index, bold: true, wrap: 'wrap' }, line.spans === undefined ? line.text : marked(line));
    if (line.spans !== undefined) return h(Text, { key: index, wrap: 'wrap' }, marked(line));
    return h(Text, { key: index, wrap: 'wrap' }, line.text);
  }));
}

// 审批问的是「要不要做这一件」，那一句改动得先看得见：写入类工具的参数里带着全文或那两段，界面上算个行数就够。
export function changeSummary(tool, args) {
  return describeChange(tool, args).summary;
}

// 审批框展开的那一段：写入类那三件说清实际动的是哪一件、要去掉哪一段、要换上哪一段（方案 5.4）。
// 两段内容都带行首的减号与加号，读的人不必自己对照；没读过的正文不画，删除那一条只说移进回收站。
function approvalBody(tool, args) {
  const change = describeChange(tool, args);
  if (change.action === '') return typeof args.content === 'string' ? args.content : JSON.stringify(args, null, 2);
  const marked = (text, sign) => (text === '' ? [`${sign}（那一段是空的）`] : text.split('\n').map((line) => `${sign} ${line}`));
  return [change.action,
    ...(change.before === '' ? [] : ['要去掉的那一段:', ...marked(change.before, '-')]),
    ...(change.after === '' ? [] : ['要换上的那一段:', ...marked(change.after, '+')]),
  ].join('\n');
}

function Row({ row, expanded, columns }) {
  if (row.kind === 'question') return h(Text, { color: 'cyan' }, `› ${row.text}`);
  if (row.kind === 'reasoning') {
    const folded = foldText(row.text, expanded, 1);
    return h(Fragment, null,
      h(Text, { dimColor: true, wrap: 'truncate-end' }, `· 推理 ${folded.shown}`),
      folded.hidden > 0 ? h(Text, { dimColor: true }, `  …还有 ${folded.hidden} 字推理，${keyHint('expand-or-history')} 展开`) : null);
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
      folded.hidden > 0 ? h(Text, { dimColor: true }, `  …还有 ${folded.hidden} 字输出，${keyHint('expand-or-history')} 展开`) : null);
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

// 一道题在画面上怎么写：选中的那几条与自由回答各占一段，两样都没有就说这一格是空的（D107）。
// `undefined` 是还没走到那一题，`null` 是走到过、回车交的是空的一句——两者交回宿主之后都记成「没有回答」，画面上要说清是哪一种。
const answeredLine = (answer) => answer === undefined ? '还没答'
  : answer === null ? '空着交出的'
  : [answer.selected.join('、'), answer.custom].filter((one) => one !== '' && one !== undefined).join('；') || '没选中也没写';

// 那一格下面说的是「怎么答」：有选项时要把编号那条写出来，人不然只会照着题面写一句自由回答（D107）。
const optionHint = (question) => question.options.length === 0
  ? '在下面的输入里写一句回答'
  : question.multiSelect ? '在下面的输入里写一句回答，或写几条编号选出那几项' : '在下面的输入里写一句回答，或写那一条的编号';

export function App({ client, sessionId: firstSessionId, info = {}, interactive = true, stdout, history = { entries: [], remember: async () => {} }, inputs, keys }) {
  const app = useApp();
  const [sessionId, setSessionId] = useState(firstSessionId);
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;
  const [geometry, setGeometry] = useState({ columns: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 });
  const [rows, setRows] = useState([]);
  const [live, setLive] = useState({ text: '', reasoning: '' });
  const [ask, setAsk] = useState(null);
  // 模型的提问（D107）：一次请求一到四道题，答一道前进一道，答完最后一道才把答复交回去。
  const [query, setQuery] = useState(null);
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  // 草稿的撤销栈（方案 6.1）：人在这一格里改出来的每一段，落笔时先把当时那一格的草稿与光标留下来，Ctrl+Z 退回它、Ctrl+Y 再拿回来。
  // 只留在这一次打开的内存里：跨退出留住的是第 84 步那两格，退出之后退回刚才打的字没有意义。
  // stack 与 future 各 100 份（ponytail: 上限写在这一处，一句草稿远够用；要更长就换成按字节预算的环形缓冲）。
  const undo = useRef({ stack: [], future: [], kind: null, before: { draft: '', caret: 0 } });
  useEffect(() => {
    const cell = undo.current;
    const current = { draft, caret };
    const previous = cell.before;
    cell.before = current;
    if (current.draft === previous.draft) { cell.kind = null; return; }
    const run = isTypingRun(previous, current);
    // 连着打的字并上一个单位：退一次是一段，不是一个字符。
    if (run && cell.kind === 'insert') return;
    cell.stack = [...cell.stack.slice(-99), previous];
    cell.kind = run ? 'insert' : 'text';
  }, [draft, caret]);
  // 草稿整份换掉的那几处走这一条：那不是一次可退回的改动，清空栈也别让 Ctrl+Z 把另一份会话的草稿翻回来。
  const resetDraft = useCallback((text) => {
    const cell = undo.current;
    cell.stack = [];
    cell.future = [];
    cell.kind = null;
    cell.before = { draft: text, caret: text.length };
    setDraft(text);
    setCaret(text.length);
  }, []);
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
  // 取消这一轮之后队列停下等人：剩余的那几条不自己发出去（方案 5.2）。
  const [queuePaused, setQueuePaused] = useState(false);
  // 落笔处那一段 `@` 路径引用的候选：清单由宿主列出来，界面不开盘（方案 5.3、D81 边界一）。
  const [mention, setMention] = useState(null);
  // Esc 收起的是当下这一个词：接着改字会重新问，原样不动时不再弹出来挡住输入。
  const [hiddenMention, setHiddenMention] = useState('');
  const mentionWanted = useRef(NO_TOKEN);
  const mentionAsked = useRef(NO_TOKEN);
  // 退出之后流已经关了：那时候再落一行会让 Ink 往关掉的输出上写，报出来的是 `write after end`，
  // 而不是那一句真正想说的话。这一格只用来让迟到的答复与状态刷新不再往画面上写。
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const push = useCallback((...added) => {
    if (!alive.current) return;
    setRows((current) => [...current, ...added]);
  }, []);
  // 个人键位那一份覆盖读自本机的另一份文件，写也写回那里：不进记录、不进模型上下文、不进项目的业务配置（方案 6.1、D81 边界二）。
  const [keyOverrides, setKeyOverrides] = useState({});
  useEffect(() => {
    if (keys === undefined) return;
    void (async () => {
      const loaded = await keys.read().catch((error) => ({ overrides: {}, refused: [`那一格读不出来：${error.code ?? error.message}`] }));
      const outcome = applyOverrides(loaded.overrides);
      setKeyOverrides(Object.fromEntries(outcome.applied.map((action) => [action, CURRENT[action]])));
      const refused = [...loaded.refused, ...outcome.refused];
      // 落不下来的那几条一条条说出来：剩下的那些照样按默认那一份走，但「你以为改掉了其实没有」这件事要说得见。
      if (refused.length > 0) push({ kind: 'meta', text: `键位里有 ${refused.length} 条落不下来，那几条按默认那一份走：${refused.join('、')}` });
      else if (outcome.applied.length > 0) push({ kind: 'meta', text: `接上你上次存的键位：改过 ${outcome.applied.length} 条，看一眼用 /bind` });
    })();
  }, [keys, push]);
  // 排着的那几条与草稿都属于那一份会话：换看别的一份时把这一份收起来，换回来再摊开——
  // 既不把没发的话送到另一份会话里，也不把它丢掉（方案 5.2「队列按会话隔离」）。
  const inputState = useRef(new Map());
  const viewedSession = useRef(sessionId);
  useEffect(() => {
    if (viewedSession.current === sessionId) return;
    inputState.current.set(viewedSession.current, { queue, queuePaused, draft });
    const saved = inputState.current.get(sessionId);
    setQueue(saved?.queue ?? []);
    setQueuePaused(saved?.queuePaused ?? false);
    resetDraft(saved?.draft ?? '');
    viewedSession.current = sessionId;
  }, [draft, queue, queuePaused, sessionId]);

  // 退出之前没发出去的那一句与排着的几句留在本机这一份文件里：接上哪一份会话就读哪一份（方案 5.1）。
  // 只在本次没摊开过的那一份上读一次；读回来时人已切走的丢掉，不盖到另一份的草稿上。
  const inputNow = useRef({ draft: '', queue: [] });
  inputNow.current = { draft, queue };
  useEffect(() => {
    if (inputs === undefined) return;
    const own = sessionId;
    const root = info.boundary ?? '';
    if (inputState.current.has(own)) return;
    void (async () => {
      const saved = await inputs.read(root, own);
      if (viewedSession.current !== own) return;
      inputState.current.set(own, { queue: saved.queued, queuePaused: saved.queued.length > 0, draft: saved.draft });
      // 那一句读回来的路上人已经自己敲了字：以他敲的为准，不拿一份旧的盖过去。
      if (saved.draft !== '' && inputNow.current.draft === '') resetDraft(saved.draft);
      // 排着的几句恢复成暂停：那几句当时还没发出去，重启之后自己发是替人做了他没要的决定（方案 5.2）。
      if (saved.queued.length > 0 && inputNow.current.queue.length === 0) {
        setQueue(saved.queued);
        setQueuePaused(true);
      }
    })().catch(() => inputState.current.delete(own));
  }, [info.boundary, inputs, sessionId]);

  // 手停下来 400 毫秒才写这一份：敲字那一段不碰磁盘，而退出与崩溃前那一句已经落下了。
  useEffect(() => {
    if (inputs === undefined) return;
    const own = sessionId;
    const root = info.boundary ?? '';
    const timer = setTimeout(() => {
      void inputs.write(root, own, draft, queue).catch(() => push({ kind: 'error', text: '这一句在本机存不住：退出再打开时它不会回来' }));
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, info.boundary, inputs, push, queue, sessionId]);

  // 落笔处那一段 `@` 交给宿主去列：等手停下 160 毫秒再问一次，答回来时那一段已经变了就丢掉（方案 5.3）。
  // 传输那一层没有中途取消的办法，所以「慢请求可取消」在这儿做到的是「不落到画面上」。
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
    setMention({ ...token, paths: [], chosen: 0, stopped: 'pending' });
    const timer = setTimeout(() => {
      void (async () => {
        const listed = await client.request('paths.list', { projectRoot: info.boundary, query: token.text, limit: MENTION_ROWS })
          .catch((error) => ({ code: error.code ?? 'paths_list_failed' }));
        const now = mentionWanted.current;
        if (now.start !== token.start || now.text !== token.text) return;
        setMention(listed.code === undefined
          ? { ...token, paths: listed.paths, stopped: listed.stopped, chosen: 0 }
          : { ...token, paths: [], stopped: 'error', failed: listed.code, chosen: 0 });
      })();
    }, 160);
    return () => clearTimeout(timer);
  }, [caret, client, draft, hiddenMention, info.boundary]);
  const [sessionPicker, setSessionPicker] = useState(null);
  const [approvalExpanded, setApprovalExpanded] = useState(false);
  const [approvalCursor, setApprovalCursor] = useState(0);

  const refreshStatus = useCallback(async () => {
    // 界面已经收掉了：这一处不去敲那条已经关掉的连接，免得一次迟到的收尾变成一条没人接的错误。
    if (!alive.current) return;
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
      if (message.method === 'question.request') {
        // 终端界面一次盯一份会话：别的那一份问过来的题在这一格里答不了（审批那一条同一处门）。
        const asked = message.params;
        if (asked.sessionId !== sessionId || !Array.isArray(asked.questions) || asked.questions.length === 0) return;
        setDetail(null);
        setSessionPicker(null);
        setSearch(null);
        setExpanded(false);
        setQuery({ id: message.id, questions: asked.questions, at: 0, picked: {} });
        return;
      }
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
        content: approvalBody(message.params.tool, args),
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
      // 打断落在还在跑的模型调用上时端点那一头交回 `provider_cancelled`，落在两组调用之间才是 `loop_cancelled`：
      // 人要读的是同一句——这一轮是他停下来的（方案 5.2）。
      if (code === 'loop_cancelled' || code === 'provider_cancelled') push({ kind: 'meta', text: '这一轮已被打断' });
      else push({ kind: 'error', text: `${code}：${error.detail ?? error.message ?? ''}` });
    } finally {
      setAsk(null);
      // 这一轮结束了，还没答完的那几道题也不再有人等：宿主那一侧把取消记成一条结果，画面上这一格跟着收掉（D107）。
      setQuery(null);
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
        // 排版与落盘都在宿主那一侧（方案 6A），这里只把人打的那一条路径按当前目录定成目的地：
        // 宿主可能在别的进程里，相对路径要按敲下这一行的位置算。
        const done = await client.request('session.export', { sessionId, path: resolve(argument) }).catch((error) => error);
        if (done.code !== undefined) {
          push({ kind: 'error', text: `导出没成：${done.code}${done.detail === undefined ? '' : ` · ${done.detail}`}` });
          return;
        }
        // 没写出去的那几份分两种：那一条支线的记录读不回来，与那一个位置已经有同名文件而这一份没人确认过要不要盖（审阅 F6）。
        for (const item of done.skipped) {
          push({ kind: 'error', text: item.code === 'export_target_exists'
            ? `那一个位置已经有 ${item.path ?? `支线 ${item.id}`} 那一份，这里没有盖它`
            : `支线 ${item.id} 读不回来：${item.code}，那一份没写出去` });
        }
        for (const item of done.failed) {
          push({ kind: 'error', text: `那一份没写成：${item.path}（${item.code}）` });
        }
        push({ kind: 'meta', text: `已写出 ${done.written.length} 份文件：\n${done.written.join('\n')}` });
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
    if (name === 'find') {
      const wanted = argument.trim();
      if (wanted === '') {
        push({ kind: 'meta', text: '要找哪一段文字：/find <文字>' });
        return;
      }
      void (async () => {
        // 查的也是宿主扫的那一份记录目录，界面不开盘（D81 边界一）；交回的是「哪一份会话的第几条」（方案 4.2）。
        // 当前这一份另问一次并指名道姓：那一次结果溢出在文件里的整段正文也进来，跨会话那一种只读到记录留着的那一头一尾。
        const [listed, deep] = await Promise.all([
          client.request('sessions.search', { query: wanted, projectRoot: info.boundary }).catch((error) => error),
          client.request('sessions.search', { query: wanted, sessionId }).catch((error) => error),
        ]);
        for (const answer of [listed, deep]) {
          if (answer.code !== undefined) push({ kind: 'error', text: `查不了：${answer.code}${answer.detail === undefined ? '' : ` · ${answer.detail}`}` });
        }
        if (listed.code !== undefined && deep.code !== undefined) return;
        const here = deep.code === undefined ? deep.hits : [];
        const others = listed.code === undefined ? listed.hits.filter((hit) => hit.sessionId !== sessionId) : [];
        push({ kind: 'meta', text: here.length + others.length === 0
          ? `这个项目根跑过的会话里没有含「${wanted}」的`
          : [
            ...(here.length === 0 ? [] : ['这一份会话（含溢出在文件里的那一段）：', ...findLines(here, '')]),
            ...(others.length === 0 ? [] : ['其他会话：', ...findLines(others, sessionId)]),
          ].join('\n') });
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
            + (opened.code === 'resume_mode_changed' ? `；指名一份再来一次：/resume ${wanted} <模式名>` : '')
            + (opened.code === 'session_is_branch' ? '；那一次派生做过什么用 /sub <序号> 读' : '') });
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
    if (name === 'branch') {
      // 两个入口在这一条命令上合成一个：不带序号是整份复制，带一个序号是带到那一轮完整结束那一条（方案 4.3）。
      // 序号读不出整数就当场说清：一个猜出来的分支点比没有分支点更坏（4.3「不猜测历史分支点」）。
      const wanted = argument.trim();
      const at = wanted === '' ? undefined : Number(wanted);
      if (at !== undefined && !Number.isInteger(at)) {
        push({ kind: 'error', text: `那个分支点是记录里的序号：/branch [序号]（${wanted} 不是序号；不带序号就复制整份）` });
        return;
      }
      void (async () => {
        const branched = await client.request('session.branch', { sessionId, ...(at === undefined ? {} : { at }) }).catch((error) => error);
        if (branched.code !== undefined) {
          push({ kind: 'error', text: `分支没成：${branched.code}${branched.detail === undefined ? '' : ` · ${branched.detail}`}` });
          return;
        }
        push({ kind: 'meta', text: `复制成一份新的会话 ${branched.sessionId.slice(0, 8)}：带到第 ${branched.at} 条为止，共 ${branched.events} 条，原来那一份不动` });
        // 接上去走的是 `/resume` 那一条路：打开、读回、投影、收掉上一份，一次只看一份会话（D85）。
        // 那一份没配上的派发由这一次打开补成未知结果，补它用的是分支自己的装配（D72、方案 4.3）。
        runCommand('resume', branched.sessionId);
      })();
      return;
    }
    if (name === 'bind') {
      // 改的是那一个动作的键，动作名不动：画面上说的那串字与按键落的事都从同一份表读，改完两处一起变（方案 6.1）。
      const parts = argument.trim().split(/\s+/).filter((part) => part !== '');
      const save = (next) => {
        if (keys === undefined) {
          push({ kind: 'meta', text: '这一份界面没接上键位的存储：改的键只在这次运行里有效' });
          return;
        }
        void keys.write(next).catch(() => push({ kind: 'error', text: '键位存不住：退出再打开时它会回到原来那一份' }));
      };
      if (parts.length === 0) {
        push({ kind: 'meta', text: [
          `现在这一份键位（你改过 ${Object.keys(keyOverrides).length} 条）。改一记键：/bind <动作> <键的写法>；退回默认：/bind reset <动作> 或 /bind default。`,
          ...Object.entries(KEYMAP).map(([action, binding]) => `${action} = ${formatKeys(CURRENT[action])}（${binding.view}）`),
        ].join('\n') });
        return;
      }
      if (parts[0] === 'default') {
        for (const [action, spec] of Object.entries(defaultSpecs())) CURRENT[action] = spec;
        setKeyOverrides({});
        save({});
        push({ kind: 'meta', text: '键位整份回到默认那一份' });
        return;
      }
      if (parts[0] === 'reset') {
        const action = parts[1];
        if (action === undefined || KEYMAP[action] === undefined) {
          push({ kind: 'error', text: `表里没有那一个动作：${action ?? '（没写）'}。先看一眼 /bind 列出来的那一些名字` });
          return;
        }
        CURRENT[action] = KEYMAP[action].spec;
        const next = { ...keyOverrides };
        delete next[action];
        setKeyOverrides(next);
        save(next);
        push({ kind: 'meta', text: `${action} 回到 ${formatKeys(KEYMAP[action].spec)}` });
        return;
      }
      const [action, text] = parts;
      const binding = KEYMAP[action];
      if (binding === undefined) {
        push({ kind: 'error', text: `表里没有那一个动作：${action}。先看一眼 /bind 列出来的那一些名字` });
        return;
      }
      const spec = parseSpec(text ?? '');
      if (spec === null) {
        push({ kind: 'error', text: `那一串键读不懂：${text ?? '（没写）'}。写法是 修饰键+键名，例如 Ctrl+Shift+K、enter、pageup` });
        return;
      }
      // 先按这一条试一遍：同一个范围里两记键要落同一件事就拒，存下去的表必须是自己按得动的。
      const clash = conflictsIn(binding.view, { ...CURRENT, [action]: spec });
      if (clash.length > 0) {
        push({ kind: 'error', text: `${formatKeys(spec)} 在${binding.view}里已经落在 ${clash[0][0]} 与 ${clash[0][1]} 上：同一范围里不能两记键落同一件事，先把那一条改开` });
        return;
      }
      CURRENT[action] = spec;
      const next = { ...keyOverrides, [action]: spec };
      setKeyOverrides(next);
      save(next);
      push({ kind: 'meta', text: `${action} 现在是 ${formatKeys(spec)}（${binding.view}）：${binding.label}` });
      return;
    }
    if (name === 'queue') {
      // 队列是界面一侧那几行字：这一处只答「怎么走下去」与「收回到哪儿」，不动记录（D81 边界二、方案 5.2）。
      const [action, ordinal] = argument.split(/\s+/);
      if (action === undefined || action === '' || action === 'list') {
        push({ kind: 'meta', text: queue.length === 0 ? '队列是空的'
          : [
            `排队 ${queue.length} 条（${queuePaused ? '暂停中：接着发用 /queue continue' : '本轮结束后按先后自动发出'}）：`,
            ...queue.map((item, index) => `${index + 1} · ${queuedLine(item)}`),
          ].join('\n') });
        return;
      }
      if (action === 'pause' || action === 'continue') {
        setQueuePaused(action === 'pause');
        push({ kind: 'meta', text: action === 'pause'
          ? `队列暂停：还有 ${queue.length} 条没发`
          : queue.length === 0 ? '队列是空的，解开暂停不发任何东西'
            : `队列接着走：${running ? '本轮结束后' : '现在'}发第 1 条，共 ${queue.length} 条` });
        return;
      }
      // 丢出去的那一条不扔：它回到草稿，那才是人写东西的那一格（5.2「取消项仍能恢复文本」）。
      // 走到这一条时那行命令自己已经从草稿清掉了，所以草稿是空的那一格，不会把两句拼在一起。
      if (action === 'drop') {
        const wanted = ordinal === undefined ? queue.length : Number(ordinal);
        const at = wanted - 1;
        if (!Number.isInteger(wanted) || at < 0 || at >= queue.length) {
          push({ kind: 'error', text: `那一条不排在队列里：/queue drop <序号>，现在共 ${queue.length} 条` });
          return;
        }
        const recovered = queue[at];
        setQueue((current) => current.filter((_, index) => index !== at));
        setDraft(recovered);
        setCaret(recovered.length);
        push({ kind: 'meta', text: `第 ${at + 1} 条收回草稿：${queuedLine(recovered)}` });
        return;
      }
      if (action === 'clear') {
        if (queue.length === 0) {
          push({ kind: 'meta', text: '队列是空的' });
          return;
        }
        const recovered = queue.join('\n\n');
        setQueue([]);
        setQueuePaused(false);
        setDraft(recovered);
        setCaret(recovered.length);
        push({ kind: 'meta', text: `排队的那 ${queue.length} 条都收回草稿，中间空一行分开` });
        return;
      }
      push({ kind: 'error', text: `/queue 不认 ${action}：可写 list、pause、continue、drop <序号>、clear` });
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
    if (name === 'name' || name === 'archive' || name === 'unarchive') {
      // 名字与归档标记由宿主写成记录里的一条事实：界面不留第二份，两端读的是同一份（方案 4.2、实现顺序第 75 步）。
      const label = name === 'name' ? { name: argument.trim() } : { archived: name === 'archive' };
      if (name === 'name' && label.name === '') {
        push({ kind: 'error', text: '名字要写几个字：/name <文字>' });
        return;
      }
      void (async () => {
        const done = await client.request('session.label', { sessionId, ...label }).catch((error) => error);
        if (done.code !== undefined) {
          push({ kind: 'error', text: `改不了：${done.code}${done.detail === undefined ? '' : ` · ${done.detail}`}` });
          return;
        }
        push({ kind: 'meta', text: `这一份会话：${done.name === '' ? '没起过名字' : `名字「${done.name}」`}，${done.archived ? '已归档（列表默认不画它，/unarchive 取消）' : '未归档'}` });
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
    if (name === 'policy') {
      void (async () => {
        // 档位有两件来源：配置文件那一份默认与这一份会话的覆盖（D101）。不带参数只是问现在按哪一档、出自哪一件。
        if (argument === '') {
          const current = await client.request('status.get', { sessionId }).catch(() => null);
          setStatus(current);
          push({ kind: 'meta', text: current === null ? '档位读不到'
            : `当前 ${current.policy}（${current.policySource === 'session' ? '这一份会话改的' : '配置默认'}），配置里写的是 ${current.policyDefault ?? '读不到'}` });
          return;
        }
        const asked = argument === 'reset' ? 'default' : argument;
        if (asked !== 'default' && asked !== 'ask' && asked !== 'auto') {
          push({ kind: 'error', text: `/policy 只认 ask、auto 与 reset，打的是 ${argument}` });
          return;
        }
        const changed = await client.request('policy.set', { sessionId, mode: asked }).catch((error) => error);
        if (changed.code !== undefined) {
          push({ kind: 'error', text: `改不过去：${changed.code}${changed.detail === undefined ? '' : ` · ${changed.detail}`}` });
          return;
        }
        setStatus(await client.request('status.get', { sessionId }).catch(() => null));
        push({ kind: 'meta', text: changed.policySource === 'session'
          ? `这一份会话从现在起按 ${changed.policy} 走，配置文件里那一份还是 ${changed.policyDefault}`
          : `退回配置默认：${changed.policy}` });
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
  }, [app, client, info, keyOverrides, keys, push, queue, queuePaused, sessionId, status, stdout]);

  // 答一道题：回车把这一题的答话记下并走到下一题，最后一题答完才把整份答复交回去（D107）。
  // 空着回车也往前走：那一题在宿主那里记成「没有回答」，模型读到的就是没答，不是界面替它编的一个答案。
  const answerQuery = useCallback((text) => {
    const head = query;
    const question = head.questions[head.at];
    const picked = { ...head.picked, [question.id]: { raw: text, answer: answerOf(question, text) } };
    resetDraft('');
    if (head.at + 1 < head.questions.length) {
      setQuery({ ...head, at: head.at + 1, picked });
      return;
    }
    const answers = head.questions.map((one) => picked[one.id]?.answer).filter((one) => one !== undefined && one !== null);
    setQuery(null);
    push({ kind: 'meta', text: `已交出 ${answers.length}/${head.questions.length} 道题的回答${answers.length === head.questions.length ? '' : '，其余按「没有回答」记下'}` });
    client.reply(head.id, { answers });
  }, [client, push, query, resetDraft]);

  const send = useCallback((text) => {
    // 答题这一格开着时回车交的是这一题的答话，不是新的一轮；斜杠开头的仍按命令走，人还能用 /status 与 /queue（D107）。
    if (query !== null && !text.trim().startsWith('/')) {
      answerQuery(text);
      return;
    }
    const route = routeInput(text, running);
    if (route.kind === 'blocked') {
      push({ kind: 'meta', text: `这一轮跑着的时候 ${route.usage} 用不了；${keyHint('interrupt')} 先打断这一轮` });
      return;
    }
    resetDraft('');
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
  }, [answerQuery, push, query, remember, runCommand, running, submit]);

  // 本轮结束后把队列里的第一条发出去：一次只发一条，剩下的接着排；被打断也算这一轮结束（D20）。
  // 人按下取消之后队列是停着的：那时不自动发，剩下的每一句都要等一次显式的继续（方案 5.2）。
  useEffect(() => {
    if (running || queuePaused || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void submit(next);
  }, [queue, queuePaused, running, submit]);

  // 打断这一轮这一处动作有两个入口（审批框上的 Esc 与平时的 Esc），停下队列这件事只在一份说明里做。
  const cancelRound = useCallback(() => {
    if (queue.length > 0) {
      setQueuePaused(true);
      push({ kind: 'meta', text: `队列停下：还有 ${queue.length} 条没发，接着发用 /queue continue` });
    }
    void client.request('run.cancel', { sessionId }).catch((error) => push({ kind: 'error', text: error.code ?? 'run_cancel_failed' }));
  }, [client, push, queue.length, sessionId]);

  // 候选每次从当前草稿算出来：草稿改一个字清单就跟着变，不需要再维护一份状态（D81）。
  const templates = status?.templates ?? [];
  const picks = dismissedAt === draft || search !== null || detail !== null || sessionPicker !== null || ask !== null || query !== null ? [] : candidatesOf(draft, templates);
  const chosen = picks.length === 0 ? 0 : Math.min(pick, picks.length - 1);
  const searched = search === null ? [] : searchHistory(entries, search.query);
  const viewLines = useMemo(() => detail === null ? [] : transcriptLines(detail.rows, Math.max(1, geometry.columns - 6)), [detail?.rows, geometry.columns]);
  const viewHeight = Math.max(1, geometry.rows - 12 - (ask === null ? 0 : 7));
  const view = viewportPosition(detail?.cursor ?? 0, viewLines.length, viewHeight, detail?.offset ?? 0);
  const selection = detail?.anchor === undefined || detail.anchor === null ? [view.cursor, view.cursor] : [Math.min(detail.anchor, view.cursor), Math.max(detail.anchor, view.cursor)];
  const approvalLines = useMemo(() => ask === null ? [] : wrapLine(ask.content, Math.max(1, geometry.columns - 6)), [ask?.content, geometry.columns]);
  const approvalHeight = Math.max(1, geometry.rows - 12);
  const approvalView = viewportPosition(approvalCursor, approvalLines.length, approvalHeight);
  // 答题那一格要画的几样：题面、已经走过的几道各自记成了什么、这是不是最后一道（D107）。
  const asking = query === null ? null : {
    count: query.questions.length,
    current: query.questions[query.at],
    title: query.questions[query.at].header === undefined ? query.questions[query.at].question
      : `${query.questions[query.at].header} · ${query.questions[query.at].question}`,
    done: query.questions.slice(0, query.at).map((one, index) => `第 ${index + 1} 道已记下：${answeredLine(query.picked[one.id]?.answer)}`),
    last: query.at + 1 === query.questions.length,
  };
  const caretText = useMemo(() => [...GRAPHEMES.segment(draft.slice(caret))][0]?.segment ?? ' ', [draft, caret]);

  useInput((input, key) => {
    if (hit('quit', input, key)) {
      app.exit();
      return;
    }
    if (hit('expand-or-history', input, key)) {
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
    if (ask !== null && hit('approval-cancel', input, key)) {
      cancelRound();
      return;
    }
    if (ask !== null && approvalExpanded) {
      const target = hit('approval-top', input, key) ? 0 : hit('approval-bottom', input, key) ? approvalLines.length - 1
        : hit('approval-page-up', input, key) ? approvalView.cursor - approvalHeight : hit('approval-page-down', input, key) ? approvalView.cursor + approvalHeight
          : hit('approval-up', input, key) ? approvalView.cursor - 1 : hit('approval-down', input, key) ? approvalView.cursor + 1 : null;
      if (target !== null) { setApprovalCursor(target); return; }
    }
    if (ask !== null) {
      if (hit('approve', input, key)) {
        const asked = ask;
        setAsk(null);
        push({ kind: 'meta', text: `已允许 ${asked.tool}` });
        client.reply(asked.id, { decision: 'allow' });
      } else if (hit('deny', input, key)) {
        const asked = ask;
        setAsk(null);
        push({ kind: 'meta', text: `已不允许 ${asked.tool}` });
        client.reply(asked.id, { decision: 'deny' });
      }
      return;
    }
    // 答题那一格：← 在草稿空着时退回上一题，把那一题刚才写的原文放回草稿里改；改完再回车，交出去的是改过的那一份。
    // 草稿非空时这一记仍归光标移动——答题要写得了一句话，退回上一题是偶尔做的事（D107）。
    if (query !== null && draft === '' && hit('question-back', input, key)) {
      const back = Math.max(0, query.at - 1);
      resetDraft(query.picked[query.questions[back].id]?.raw ?? '');
      setQuery({ ...query, at: back });
      return;
    }
    if (detail !== null && ask === null) {
      if (hit('view-close', input, key)) { setDetail(null); setExpanded(false); return; }
      if (hit('copy-selection', input, key)) {
        void copyToClipboard(selectedText(viewLines, view.cursor, detail.anchor ?? null)).then((done) => {
          if (done.code !== undefined) push({ kind: 'error', text: `复制失败：${done.code}` });
        });
        return;
      }
      // 带着 Shift 的那两记先落进「扩选」那两条，移动本身跟着走：选中的起点就是那一次按下落下的位置。
      const marked = hit('mark-up', input, key) || hit('mark-down', input, key);
      const up = hit('view-up', input, key) || hit('mark-up', input, key);
      const down = hit('view-down', input, key) || hit('mark-down', input, key);
      const target = hit('view-top', input, key) ? 0 : hit('view-bottom', input, key) ? viewLines.length - 1
        : hit('view-page-up', input, key) ? view.cursor - viewHeight : hit('view-page-down', input, key) ? view.cursor + viewHeight
          : up ? view.cursor - 1 : down ? view.cursor + 1 : null;
      if (target !== null) {
        const moved = viewportPosition(target, viewLines.length, viewHeight, view.offset);
        setDetail({ ...detail, ...moved, anchor: marked ? detail.anchor ?? view.cursor : null });
        return;
      }
      return;
    }
    if (sessionPicker !== null && ask === null) {
      if (hit('list-close', input, key)) { setSessionPicker(null); return; }
      const step = hit('list-page-up', input, key) ? -viewHeight : hit('list-page-down', input, key) ? viewHeight
        : hit('list-up', input, key) ? -1 : hit('list-down', input, key) ? 1 : null;
      const at = hit('list-first', input, key) ? 0 : hit('list-last', input, key) ? sessionPicker.items.length - 1
        : step === null ? null : Math.max(0, Math.min(sessionPicker.at + step, sessionPicker.items.length - 1));
      if (at !== null) { setSessionPicker({ ...sessionPicker, at }); return; }
      if (hit('list-open', input, key) && draft === '') {
        if (running) push({ kind: 'meta', text: '当前轮次结束后才能切换会话' });
        else runCommand('resume', sessionPicker.items[sessionPicker.at].id);
        return;
      }
      if (input !== '' && !key.ctrl && !key.meta) setSessionPicker(null);
    }
    // Ctrl+G 把草稿交给外面那一份编辑器：这一段文本走一份临时文件，回来的是它写回的那一份。
    // 让出终端这件事归 Ink（raw mode 与重画都在它手里），否则编辑器与界面抢同一把输入。
    if (hit('editor', input, key)) {
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
    if (hit('search-open', input, key) && search === null) {
      // 起一次反查：查询串从空开始，接着打的每个字符都往它后面加。
      setSearch({ query: '', at: 0 });
      return;
    }
    if (search !== null) {
      const found = searchHistory(entries, search.query);
      const cycle = (step) => setSearch(found.length === 0 ? search : { ...search, at: (search.at + step + found.length) % found.length });
      if (hit('search-close', input, key)) {
        setSearch(null);
        return;
      }
      if (hit('search-pick', input, key)) {
        const picked = found[search.at];
        if (picked !== undefined) {
          setDraft(picked);
          setCaret(picked.length);
        }
        setSearch(null);
        return;
      }
      if (hit('search-up', input, key) || hit('search-cycle', input, key)) {
        cycle(1);
        return;
      }
      if (hit('search-down', input, key)) {
        cycle(-1);
        return;
      }
      if (hit('search-back', input, key) || hit('search-back-alt', input, key)) {
        // 查询串空着时再按退格就是退出反查，不是把空格当内容删。
        setSearch(search.query === '' ? null : { query: search.query.slice(0, -1), at: 0 });
        return;
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        setSearch({ query: search.query + input, at: 0 });
      }
      return;
    }
    // 路径候选开着时这几记按键归清单：Enter 是选中那一条，不是发送（方案 5.3「选中候选不能触发发送」）。
    // 一条候选都没有时 Enter 照旧发这一句——那时清单上说的是「没有对得上的文件」，不该把发送挡住。
    if (mention !== null && ask === null && query === null && detail === null && sessionPicker === null && search === null) {
      if (hit('path-close', input, key)) {
        setHiddenMention(mention.text);
        setMention(null);
        return;
      }
      const picking = hit('pick-path', input, key) || hit('pick-path-alt', input, key);
      // 那一次查询还没回来时 Enter 什么都不做：既不是选一条旧的候选，也不是把这一句发出去（方案 5.3）。
      if (mention.stopped === 'pending' && picking) return;
      if (mention.paths.length > 0 && picking) {
        const picked = mention.paths[Math.min(mention.chosen, mention.paths.length - 1)];
        const merged = insertMention(draft, caret, mention.start, picked);
        setDraft(merged.draft);
        setCaret(merged.caret);
        setHiddenMention('');
        setMention(null);
        return;
      }
      if (mention.paths.length > 0 && (hit('path-up', input, key) || hit('path-down', input, key))) {
        const step = hit('path-up', input, key) ? -1 : 1;
        setMention({ ...mention, chosen: (mention.chosen + step + mention.paths.length) % mention.paths.length });
        return;
      }
    }
    if (picks.length > 0) {
      if (hit('complete', input, key)) {
        const picked = picks[chosen];
        // 带参数提示的那一条补完留一个空格，光标落在要写参数的地方；不带的补完就能直接发。
        const completed = `/${picked.name}${picked.hint === '' ? '' : ' '}`;
        setDraft(completed);
        setCaret(completed.length);
        setPick(0);
        return;
      }
      if (hit('complete-up', input, key) || hit('complete-down', input, key)) {
        setPick(hit('complete-up', input, key) ? (chosen === 0 ? picks.length - 1 : chosen - 1) : (chosen + 1) % picks.length);
        return;
      }
      if (hit('complete-close', input, key)) {
        setDismissedAt(draft);
        return;
      }
    }
    if (hit('interrupt', input, key)) {
      if (running) cancelRound();
      return;
    }
    const up = hit('history-up', input, key) || hit('history-up-shift', input, key);
    const down = hit('history-down', input, key) || hit('history-down-shift', input, key);
    if (up || down) {
      if (draft.includes('\n')) {
        const start = draft.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
        const column = caret - start;
        if (up && start > 0) {
          const previous = draft.lastIndexOf('\n', start - 2) + 1;
          setCaret(Math.min(previous + column, start - 1));
        } else if (down) {
          const next = draft.indexOf('\n', caret);
          if (next >= 0) {
            const end = draft.indexOf('\n', next + 1);
            setCaret(Math.min(next + 1 + column, end < 0 ? draft.length : end));
          }
        }
        return;
      }
      if (entries.length === 0) return;
      if (historyAt === -1 && up) setHistoryDraft(draft);
      const next = up ? Math.min(historyAt + 1, entries.length - 1) : Math.max(historyAt - 1, -1);
      setHistoryAt(next);
      const recalled = next < 0 ? historyDraft : entries[next];
      setDraft(recalled);
      setCaret(recalled.length);
      return;
    }
    if (hit('undo-draft', input, key) || hit('redo-draft', input, key)) {
      // 退回去与再退回来：两侧各留一份栈，Ctrl+Z 退过头还能用 Ctrl+Y 拿回来——多退一步不是真的把那句草稿丢掉。
      const cell = undo.current;
      const back = hit('undo-draft', input, key);
      const target = (back ? cell.stack : cell.future).at(-1);
      if (target === undefined) return;
      const current = { draft: cell.before.draft, caret: cell.before.caret };
      if (back) {
        cell.stack = cell.stack.slice(0, -1);
        cell.future = [...cell.future.slice(-99), current];
      } else {
        cell.future = cell.future.slice(0, -1);
        cell.stack = [...cell.stack.slice(-99), current];
      }
      cell.kind = null;
      cell.before = target;
      setDraft(target.draft);
      setCaret(target.caret);
      return;
    }
    if ((hit('queue-recall', input, key) || hit('queue-recall-alt', input, key)) && draft === '' && queue.length > 0) {
      // 草稿已经空着时按退格，最后排进来的那一条收回草稿里：打错的那一句要能改，不必重新打一遍。
      setQueue((current) => current.slice(0, -1));
      const last = queue[queue.length - 1];
      setDraft(last);
      setCaret(last.length);
      return;
    }
    if (hit('send', input, key) || hit('newline-alt', input, key)) {
      if (hit('newline', input, key) || hit('newline-alt', input, key)) {
        const inserted = draft.slice(0, caret) + '\n' + draft.slice(caret);
        setDraft(inserted);
        setCaret(caret + 1);
        return;
      }
      // 空着回车本来什么都不发；答题那一格开着时它说的是「这一道不答」，要往前走下一道（D107）。
      if (draft.trim() !== '' || query !== null) send(draft);
      return;
    }
    const edited = editDraft(draft, caret, input.replace(/\r\n?/g, '\n'), key);
    setDraft(edited.draft);
    setCaret(edited.caret);
  // 没有真终端时不开这一路：Ink 在拿不到 raw mode 的输入上是报错而不是降级（检查里就传 interactive: false）。
  }, { isActive: interactive });

  // 整段粘贴走 Ink 的另一条通道：这一条开着时它替终端打上 bracketed paste，粘进来的那一段是一整串文本，
  // 不会被拆成一串按键——所以粘贴里的换行不会发一轮，审批框上的 `y` 也不会被粘贴按下去（方案 5.1、5.4）。
  usePaste((text) => {
    const inserted = editDraft(draft, caret, text.replace(/\r\n?/g, '\n'), {});
    setDraft(inserted.draft);
    setCaret(inserted.caret);
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
        h(Text, { dimColor: true }, `改动第 ${approvalView.cursor + 1}/${approvalLines.length} 行 · ${keyHint('approval-page-up', 'approval-page-down')} 查看 · ${keyHint('approval-top', 'approval-bottom')} 到两端`)) : null,
      h(Text, { wrap: 'truncate-end' }, `按 ${keyHint('approve')} 允许一次，按 ${keyHint('deny')} 不允许 · ${keyHint('expand-or-history')} 查看改动 · ${keyHint('approval-cancel')} 打断`)),
    asking === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'blue', paddingX: 1 },
      h(Text, { bold: true }, `模型在问 ${asking.count} 道题，现在答第 ${query.at + 1} 道`),
      h(Text, { wrap: 'truncate-end' }, asking.title),
      ...asking.current.options.map((option, position) => h(Text, { key: `option:${position}`, dimColor: true, wrap: 'truncate-end' }, `  ${position + 1}. ${option.label}${option.description === undefined ? '' : ` —— ${option.description}`}`)),
      ...asking.done.map((line, index) => h(Text, { key: `done:${index}`, dimColor: true, wrap: 'truncate-end' }, `  ${line}`)),
      h(Text, { wrap: 'truncate-end' }, `${optionHint(asking.current)}，回车${asking.last ? '交出整份答复' : '记下这一道并走到下一道'}`),
      h(Text, { dimColor: true, wrap: 'truncate-end' }, `  ${asking.done.length > 0 ? `${keyHint('question-back')} 改上一道 · ` : ''}${keyHint('interrupt')} 取消这一轮 · 这一格没有回答时限`)),
    detail === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
      h(Text, { dimColor: true, wrap: 'truncate-end' }, detail.kind === 'transcript' ? '会话完整历史' : detailTitle(detail)),
      viewLines.length === 0
        ? h(Text, { dimColor: true }, detail.loading ? '正在读取完整记录…' : '这一条没有可画的内容')
        : viewLines.slice(view.offset, view.offset + viewHeight).map((line, index) => h(Text, { key: view.offset + index, inverse: view.offset + index >= selection[0] && view.offset + index <= selection[1], wrap: 'truncate-end' }, line)),
      h(Text, { dimColor: true, wrap: 'truncate-end' }, `第 ${view.cursor + 1}/${viewLines.length} 行 · ${keyHint('view-page-up', 'view-page-down')} 分页 · ${keyHint('view-top', 'view-bottom')} 到两端 · ${keyHint('mark-up', 'mark-down')} 选择 · ${keyHint('copy-selection')} 复制 · ${keyHint('view-close')} 收起`)),
    sessionPicker === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
      h(Text, { wrap: 'truncate-end' }, `历史会话 ${sessionPicker.items.length} 份 · ${keyHint('list-up', 'list-down')} 选择 · ${keyHint('list-open')} 接上 · ${keyHint('list-close')} 收起`),
      sessionPicker.items.slice(Math.max(0, sessionPicker.at - viewHeight + 1), Math.max(0, sessionPicker.at - viewHeight + 1) + viewHeight).map((item) => h(Text, { key: item.id, inverse: item === sessionPicker.items[sessionPicker.at], wrap: 'truncate-end' }, sessionLines([item], sessionId)[0]))),
    queue.length === 0 ? null : h(Box, { flexDirection: 'column' },
      queue.map((item, index) => h(Text, { key: `${index}:${item}`, dimColor: true }, `排队 ${index + 1} · ${queuedLine(item)}`)),
      h(Text, { dimColor: true }, queuePaused
        ? '  队列暂停中（这一轮是被你打断的）：接着发用 /queue continue，收回某一条用 /queue drop <序号>'
        : '  这一轮结束后按先后发出；草稿空着时按退格收回最后一条')),
    search === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'magenta', paddingX: 1 },
      h(Text, null, `反查 ${search.query}`),
      searched.length === 0
        ? h(Text, { dimColor: true }, entries.length === 0 ? '还没有发过任何一句' : `没有哪一句含「${search.query}」`)
        : searched.map((entry, index) => h(Box, { key: `${index}:${entry}` },
            h(Text, { inverse: index === search.at }, ` ${queuedLine(entry, 60)}`))),
      h(Text, { dimColor: true }, `  接着打字缩小 · ${keyHint('search-cycle', 'search-up', 'search-down')} 换一条 · ${keyHint('search-pick')} 填进草稿 · ${keyHint('search-close')} 退出`)),
    picks.length === 0 ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
      picks.slice(Math.max(0, chosen - CANDIDATE_ROWS + 1), Math.max(0, chosen - CANDIDATE_ROWS + 1) + CANDIDATE_ROWS).map((candidate) => h(Box, { key: `${candidate.source}:${candidate.name}` },
        h(Text, { inverse: candidate === picks[chosen] }, ` /${candidate.name}${candidate.hint === '' ? '' : ` ${candidate.hint}`}`),
        h(Text, { dimColor: true }, ` ${candidate.text}`))),
      picks.length > CANDIDATE_ROWS ? h(Text, { dimColor: true }, `  还有 ${picks.length - CANDIDATE_ROWS} 条，接着打字就缩小了`) : null,
      h(Text, { dimColor: true }, ` ${keyHint('complete')} 补全 · ${keyHint('complete-up', 'complete-down')} 选 · ${keyHint('complete-close')} 收起`)),
    mention === null ? null : h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
      h(Text, { dimColor: true, wrap: 'truncate-end' }, ` 项目 ${info.boundary}`),
      mention.paths.length === 0
        ? h(Text, { dimColor: true }, mention.stopped === 'error'
          ? `这个项目列不出文件：${mention.failed}`
          : mention.stopped === 'pending'
            ? '在列这个项目的文件…'
            : mention.stopped === 'budget'
              ? `前面那些文件里没有含「${mention.text}」的，更深的没翻到：把字写得更具体一些`
              : `这个项目里没有文件名含「${mention.text}」的文件`)
        : mention.paths.map((path, index) => h(Text, { key: path, inverse: index === mention.chosen, wrap: 'truncate-end' }, ` ${path}`)),
      mention.paths.length > 0 && mention.stopped === 'budget'
        ? h(Text, { dimColor: true }, '  只翻了前面那些文件，更深的没看到：把字写得更具体一些') : null,
      mention.paths.length > 0 && mention.stopped === 'unreadable'
        ? h(Text, { dimColor: true }, '  有一层目录读不了，这份清单不一定全') : null,
      mention.paths.length === 0 ? null : h(Text, { dimColor: true }, ` ${keyHint('pick-path', 'pick-path-alt')} 选中 · ${keyHint('path-up', 'path-down')} 换一条 · ${keyHint('path-close')} 收起`)),
    h(Box, null,
      h(Text, { color: running ? 'yellow' : 'cyan' }, running ? `${SPINNER[tick % SPINNER.length]} ` : '› '),
      draft === '' && !running
        ? h(Text, { dimColor: true }, `要模型做的事（${keyHint('send')} 发送，${keyHint('newline')} 换行，打 / 看清单，打 @ 引用项目里的文件）`)
        : h(Text, { wrap: 'wrap' },
          draft.slice(0, caret),
          h(Text, { inverse: true }, caretText),
          draft.slice(caret + (caret === draft.length ? 0 : caretText.length)))),
    h(Text, { dimColor: true, wrap: 'truncate-end' }, buildStatusLine({
      head, sessionId, boundary: info.boundary, status, running, seconds, expanded, columns: stdout?.columns,
    })),
  );
}
