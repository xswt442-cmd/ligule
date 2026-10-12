// 终端界面的命令表与候选清单（D81）。这里只做「画哪几条、命中哪一条」这类纯计算。
// 命令的内容一律来自宿主：提示模板由宿主交出、展开也归宿主（D24、D49），界面不留第二份事实源。
import stringWidth from 'string-width';
import type { AskAnswer, AskQuestion } from '../tools/ask-user.js';
import { textOf, type Locale } from '../kernel/locale.js';
const WIDTH_CACHE_LIMIT = 1024;
const widthCache = new Map<string, number>();

export interface UiCommand {
  readonly name: string;
  readonly usage: string;
  readonly text: string;
  readonly hint: string;
  /** 跑着的那一轮里还能不能用：换会话会把人从这一轮带走，那一轮落下来的事件就没人在看。 */
  readonly whenRunning: boolean;
}

/** 宿主交出来的那一份提示模板，字段与 `status.get` 里那一格同名。 */
export interface TemplateCommand {
  readonly command: string;
  readonly description?: string;
  readonly hint?: string;
}

export interface Candidate {
  readonly name: string;
  readonly text: string;
  readonly hint: string;
  readonly source: 'ui' | 'template';
}

// 表的先后就是清单里的先后：常用的排在前，不按字母排（参照 codex 那条「枚举顺序即呈现顺序」）。
export const UI_COMMANDS = Object.freeze([
  { name: 'help', usage: '/help', text: '列出命令与按键', hint: '', whenRunning: true },
  { name: 'mode', usage: '/mode [名字]', text: '查看或切换工具模式', hint: '[名字]', whenRunning: true },
  { name: 'model', usage: '/model [服务 模型]', text: '列出模型服务，或切换当前会话的模型', hint: '[服务 模型]', whenRunning: true },
  { name: 'policy', usage: '/policy [ask|auto|reset]', text: '查看或修改审批方式', hint: '[ask|auto|reset]', whenRunning: true },
  { name: 'status', usage: '/status', text: '查看会话状态', hint: '', whenRunning: true },
  { name: 'compact', usage: '/compact', text: '压缩上下文（需要 limits.contextTokens）', hint: '', whenRunning: true },
  { name: 'tools', usage: '/tools', text: '列出可用工具', hint: '', whenRunning: true },
  { name: 'show', usage: '/show [序号]', text: '查看完整记录；不带序号收起', hint: '[序号]', whenRunning: true },
  { name: 'sub', usage: '/sub [序号]', text: '查看子任务记录；不带序号收起', hint: '[序号]', whenRunning: true },
  { name: 'new', usage: '/new', text: '创建新会话', hint: '', whenRunning: false },
  { name: 'queue', usage: '/queue [pause|continue|drop <序号>|clear]', text: '暂停、继续或收回待发送消息', hint: '[动作]', whenRunning: true },
  { name: 'bind', usage: '/bind [<动作> <键的写法>|reset <动作>|default]', text: '查看或修改快捷键', hint: '[动作 键|reset <动作>|default]', whenRunning: true },
  { name: 'copy', usage: '/copy', text: '复制最近的回答', hint: '', whenRunning: true },
  { name: 'export', usage: '/export <路径>', text: '将会话与子任务导出为 Markdown', hint: '<路径>', whenRunning: true },
  { name: 'sessions', usage: '/sessions', text: '浏览工作区会话（UTC 时间）', hint: '', whenRunning: true },
  { name: 'find', usage: '/find <文字>', text: '搜索工作区会话', hint: '<文字>', whenRunning: true },
  { name: 'resume', usage: '/resume <id> [模式名]', text: '通过唯一编号前缀恢复会话', hint: '<id> [模式名]', whenRunning: false },
  { name: 'branch', usage: '/branch [序号]', text: '复制会话，或从完整轮次创建分支', hint: '[序号]', whenRunning: false },
  { name: 'name', usage: '/name <文字>', text: '重命名会话', hint: '<文字>', whenRunning: true },
  { name: 'archive', usage: '/archive', text: '归档会话', hint: '', whenRunning: true },
  { name: 'unarchive', usage: '/unarchive', text: '取消归档', hint: '', whenRunning: true },
  { name: 'quit', usage: '/quit', text: '退出（Ctrl+C 同样）', hint: '', whenRunning: true },
] as const satisfies readonly UiCommand[]);

type CommandName = typeof UI_COMMANDS[number]['name'];
const ENGLISH_COMMANDS: Record<CommandName, readonly [string, string, string]> = {
  help: ['/help', 'List commands and shortcuts', ''],
  mode: ['/mode [name]', 'Show or change the tool mode', '[name]'],
  model: ['/model [service model]', 'List services or change this session’s model', '[service model]'],
  policy: ['/policy [ask|auto|reset]', 'Show or change the approval mode', '[ask|auto|reset]'],
  status: ['/status', 'Show session status', ''],
  compact: ['/compact', 'Compact context (requires limits.contextTokens)', ''],
  tools: ['/tools', 'List available tools', ''],
  show: ['/show [seq]', 'View an event; omit seq to close', '[seq]'],
  sub: ['/sub [seq]', 'View a subtask; omit seq to close', '[seq]'],
  new: ['/new', 'Start a new session', ''],
  queue: ['/queue [pause|continue|drop <n>|clear]', 'Pause, resume, or recover queued messages', '[action]'],
  bind: ['/bind [<action> <key>|reset <action>|default]', 'View or change keyboard shortcuts', '[action key|reset <action>|default]'],
  copy: ['/copy', 'Copy the latest answer', ''],
  export: ['/export <path>', 'Export conversation and subtasks as Markdown', '<path>'],
  sessions: ['/sessions', 'Browse this workspace’s sessions (UTC)', ''],
  find: ['/find <text>', 'Search this workspace’s conversations', '<text>'],
  resume: ['/resume <id> [mode]', 'Resume a session by its unique ID prefix', '<id> [mode]'],
  branch: ['/branch [seq]', 'Copy the session, or branch at a completed turn', '[seq]'],
  name: ['/name <text>', 'Rename this session', '<text>'],
  archive: ['/archive', 'Archive this session', ''],
  unarchive: ['/unarchive', 'Restore this session from the archive', ''],
  quit: ['/quit', 'Exit (also Ctrl+C)', ''],
};

export function localizedCommand(command: UiCommand, locale: Locale): UiCommand {
  if (locale === 'zh') return command;
  const [usage, text, hint] = ENGLISH_COMMANDS[command.name as CommandName];
  return { ...command, usage, text, hint };
}

export function findUiCommand(name: string): UiCommand | undefined {
  return UI_COMMANDS.find((command) => command.name === name);
}

// 写入类那一句改动说的是同一件事的两头：动的是哪一个对象、要去掉哪一段、要换上哪一段（方案 5.4）。
// 没读过的内容一律不编：删除那一条只说把哪一个对象移进回收站，正文一概不画；
// 整份写入时目标在不在由内核那条规则管（覆盖之前要先读全），界面不替它断言那是新建还是覆盖。
export type Change = { readonly summary: string; readonly action: string; readonly before: string; readonly after: string };

export function describeChange(tool: string, args: Record<string, unknown>, locale: Locale = 'zh'): Change {
  const t = (zh: string, en: string) => textOf(locale, zh, en);
  const path = typeof args.path === 'string' ? args.path : '';
  const count = (value: unknown) => String(value ?? '').split('\n').length;
  const empty: Change = { summary: '', action: '', before: '', after: '' };
  // 参数里没有路径就不编造一个对象：摘要行宁可空着，展开那一段照样把正文交出去（与桌面前端同一条规则）。
  if (path === '') return empty;
  if ((tool === 'write' || tool === 'create') && typeof args.content === 'string') {
    return {
      summary: t(`${path}：写入 ${count(args.content)} 行`, `${path}: write ${count(args.content)} lines`),
      action: t('写入完整文件；覆盖已有文件前必须完整读取', 'Write the entire file; overwriting requires reading the existing file first'),
      before: '',
      after: args.content,
    };
  }
  if (tool === 'edit' && typeof args.anchor === 'string') {
    const replacement = typeof args.replacement === 'string' ? args.replacement : '';
    return {
      summary: t(`${path}：替换 ${count(args.anchor)} 行，写入 ${count(replacement)} 行`, `${path}: replace ${count(args.anchor)} lines with ${count(replacement)} lines`),
      action: t(`${path}：替换匹配内容`, `${path}: replace matched text`),
      before: args.anchor,
      after: replacement,
    };
  }
  if (tool === 'delete') {
    return { summary: t(`将 ${path} 移入回收站`, `Move ${path} to trash`), action: t(`将 ${path} 移入系统回收站或权限边界内的回收目录`, `Move ${path} to system trash or the recovery directory within the permission boundary`), before: '', after: '' };
  }
  return empty;
}

export type InputRoute =
  | { readonly kind: 'command'; readonly name: string; readonly argument: string }
  | { readonly kind: 'run'; readonly text: string }
  | { readonly kind: 'blocked'; readonly usage: string };

const INVOCATION = /^\/([^\s]*)(?:\s+([\s\S]*))?$/;

// 一条输入落向哪里。斜杠开头的先查这张表，表里没有就整行交给宿主——提示模板只有宿主那侧展开得开（D24、D81）。
// `blocked` 是「这条命令存在，但这一轮跑着的时候不能用」，说的话与「没有这条命令」不是一回事。
export function routeInput(text: string, running: boolean): InputRoute {
  const trimmed = text.trim();
  const matched = INVOCATION.exec(trimmed);
  if (matched === null) return { kind: 'run', text: trimmed };
  const name = matched[1].toLowerCase();
  if (name === '') return { kind: 'command', name: 'help', argument: '' };
  const command = findUiCommand(name);
  if (command === undefined) return { kind: 'run', text: trimmed };
  if (running && !command.whenRunning) return { kind: 'blocked', usage: command.usage };
  return { kind: 'command', name: command.name, argument: matched[2] ?? '' };
}

const CANDIDATE_LIMIT = 8;

// 只有名字那一段还在敲的时候给候选：一旦打了空格就是在写参数，清单压在那儿只会挡住输入。
export function candidatesOf(
  draft: string,
  templates: readonly TemplateCommand[] = [],
  limit = CANDIDATE_LIMIT,
  locale: Locale = 'zh',
): Candidate[] {
  if (!draft.startsWith('/')) return [];
  const typed = draft.slice(1);
  if (typed === '' || /\s/.test(typed)) return [];
  const prefix = typed.toLowerCase();
  const fromUi = UI_COMMANDS.filter((command) => command.name.startsWith(prefix)).map(command => localizedCommand(command, locale)).map((command) => ({
    name: command.name,
    text: command.text,
    hint: command.hint,
    source: 'ui' as const,
  }));
  const fromTemplates = templates
    .filter((template) => template.command.toLowerCase().startsWith(prefix))
    .map((template) => ({
      name: template.command,
      text: template.description ?? '',
      hint: template.hint ?? '',
      source: 'template' as const,
    }));
  return [...fromUi, ...fromTemplates].slice(0, limit);
}

export interface HelpGroup {
  readonly title: string;
  readonly entries: readonly { readonly key: string; readonly action: string }[];
}

// 中日韩那一段与全角标点在一个字符位上占两列：按字符数补齐会歪，按列数补齐才对得齐（界面里全是中英混排）。
export function displayWidth(text: string): number {
  if (text.length > 32) return stringWidth(text);
  const known = widthCache.get(text);
  if (known !== undefined) return known;
  const width = stringWidth(text);
  if (widthCache.size < WIDTH_CACHE_LIMIT) widthCache.set(text, width);
  return width;
}

function padTo(text: string, columns: number): string {
  return `${text}${' '.repeat(Math.max(0, columns - displayWidth(text)))}`;
}

// 放得下就并排，放不下整组往下一层，每一列的宽度取它那一段里最宽的一行。
export function flowGroups(groups: readonly HelpGroup[], width: number, gap = 4): string[] {
  const blocks = groups.map((group) => {
    const keyWidth = group.entries.reduce((widest, entry) => Math.max(widest, displayWidth(entry.key)), 0);
    const lines = [
      group.title,
      ...group.entries.map((entry) => `${padTo(entry.key, keyWidth + 2)}${entry.action}`),
    ];
    return { lines, width: lines.reduce((widest, line) => Math.max(widest, displayWidth(line)), 0) };
  });
  const total = blocks.reduce((sum, block) => sum + block.width, 0) + gap * Math.max(0, blocks.length - 1);
  if (blocks.length > 1 && total <= width) {
    const height = blocks.reduce((tallest, block) => Math.max(tallest, block.lines.length), 0);
    const rows: string[] = [];
    for (let index = 0; index < height; index += 1) {
      const cells = blocks.map((block) => padTo(block.lines[index] ?? '', block.width));
      rows.push(cells.join(' '.repeat(gap)).trimEnd());
    }
    return rows;
  }
  const lines: string[] = [];
  for (const [index, block] of blocks.entries()) {
    if (index > 0) lines.push('');
    lines.push(...block.lines);
  }
  return lines;
}

/** 宿主从记录目录扫出来的那一栏里，界面要画的几格（`sessions.list` 交回的形状，D73）。 */
export interface SessionRow {
  readonly id: string;
  readonly updatedAt: string;
  readonly events: number;
  readonly mode: { readonly name: string } | null;
  /** 人给这份会话起的名字；没起过是空串（实现顺序第 75 步）。 */
  readonly name?: string;
  /** 归档只改列表怎么展示：记录还在，也接得回来（方案 4.2）。 */
  readonly archived?: boolean;
  readonly unanswered: number;
  readonly truncatedBytes?: number;
  readonly error?: { readonly code: string; readonly detail: string };
}

/** 列表的条数上限：界面上一次画五十行已经把终端滚出一屏，U38 那条「要不要建索引」要的是日常使用的数字。 */
export const SESSION_ROWS = 20;

// 一栏一行。id 整串写出来，因为 `/resume` 后面要跟的就是这一串；时间是记录文件的写入时间，UTC。
export function sessionLines(listed: readonly SessionRow[], current = '', locale: Locale = 'zh'): string[] {
  const t = (zh: string, en: string) => textOf(locale, zh, en);
  if (listed.length === 0) return [t('此工作区暂无会话', 'No sessions in this workspace')];
  return listed.map((item) => [
    item.updatedAt.slice(0, 19).replace('T', ' '),
    item.id,
    t(`${item.events} 条`, `${item.events} events`),
    `mode:${item.mode?.name ?? '-'}`,
    item.name === undefined || item.name === '' ? '' : `「${item.name}」`,
    item.archived === true ? t('已归档', 'archived') : '',
    item.unanswered > 0 ? t(`未收尾 ${item.unanswered} 次派发`, `${item.unanswered} unresolved calls`) : '',
    (item.truncatedBytes ?? 0) > 0 ? t(`尾行未完成 ${item.truncatedBytes} 字节`, `${item.truncatedBytes} incomplete bytes`) : '',
    item.error === undefined ? '' : t(`无法恢复：${item.error.code} · ${item.error.detail}`, `Cannot resume: ${item.error.code} · ${item.error.detail}`),
    item.id === current ? t('← 当前会话', '← current session') : '',
  ].filter((cell) => cell !== '').join('  '));
}

/** 宿主从记录目录里查出来的那一条命中（`sessions.search` 交回的形状，方案 4.2）。 */
export interface SearchRow {
  readonly sessionId: string;
  readonly seq: number;
  readonly kind: string;
  readonly text: string;
  readonly name?: string;
  readonly spilled?: string;
}

// 那一条记录里的事件种类，画给人看的是中文；认不出的一种原样画出来，不猜它是什么。
const HIT_KINDS: Record<string, string> = { user: '问', assistant: '答', reasoning: '推理', tool: '工具', label: '名字' };

// 一行一条命中：会话编号写开头八段——`/resume` 要的就是这一串，在这份列表里唯一对上就接得回来；
// 序号交给 `/show`，所以两处都整串写出来，不省略。
export function findLines(listed: readonly SearchRow[], current = '', locale: Locale = 'zh'): string[] {
  const t = (zh: string, en: string) => textOf(locale, zh, en);
  return listed.map((hit) => [
    hit.sessionId.slice(0, 8),
    hit.name === undefined || hit.name === '' ? '' : `「${hit.name}」`,
    t(`${HIT_KINDS[hit.kind] ?? hit.kind} 第 ${hit.seq} 条`, `${hit.kind} #${hit.seq}`),
    hit.text,
    hit.spilled === undefined ? '' : t(`整段在 ${hit.spilled}`, `Full result: ${hit.spilled}`),
    hit.sessionId === current ? t('← 当前会话', '← current session') : '',
  ].filter((cell) => cell !== '').join('  '));
}

// 界面上 `@` 的那一段：正被写的一个路径引用。`@` 要在句首或空白之后才算，邮箱与 `a@b` 那一种不弹候选。
const MENTION = /(?:^|(\s))@([^\s]*)$/;

/** 落笔处往回找那一个还没写完的路径引用；没有就是 null。`start` 是 `@` 的位置。
 * 笔落在一段中间（后面还跟着字）时不算：那时替换会把人已写好的那一段截断。 */
export function mentionToken(draft: string, caret: number): { readonly start: number; readonly text: string } | null {
  const after = draft.slice(caret);
  if (after !== '' && !/^\s/.test(after)) return null;
  const matched = MENTION.exec(draft.slice(0, caret));
  if (matched === null) return null;
  return { start: caret - matched[2].length - 1, text: matched[2] };
}

/** 选中一条候选后的草稿与落笔处：那一段 `@…` 换成 `@路径␣`，后面已写的字保留。 */
export function insertMention(draft: string, caret: number, start: number, path: string): { readonly draft: string; readonly caret: number } {
  const inserted = `@${path} `;
  return { draft: draft.slice(0, start) + inserted + draft.slice(caret), caret: start + inserted.length };
}

/** 前缀对上的那一份，或者一条说明为什么对不上——猜一份是把人带去他没选过的会话里。 */export type SessionPick = { readonly id: string } | { readonly code: 'tui_session_ambiguous' | 'tui_session_not_listed' };

// `ligule sessions` 里那一串 id 太长，敲一半是自然会做的事：在这份列表里唯一对上才算认。
// 列表按项目根过滤过，所以别的项目根下的会话不会被这一条接走。
export function resolveSessionId(argument: string, listed: readonly SessionRow[]): SessionPick {
  const wanted = argument.trim().toLowerCase();
  const exact = listed.find((item) => item.id.toLowerCase() === wanted);
  if (exact !== undefined) return { id: exact.id };
  const prefix = listed.filter((item) => item.id.toLowerCase().startsWith(wanted));
  if (prefix.length === 1) return { id: prefix[0].id };
  return { code: prefix.length > 1 ? 'tui_session_ambiguous' : 'tui_session_not_listed' };
}

/**
 * 模型那一道题在终端里怎么答（D107）：写的是一到四这一个范围内的纯编号就选中那几条选项，其余文本原样作为自由回答记下，空着就是这一题不答。
 * 不做「答话里出现了某一条选项的名字」那种匹配：猜人要说什么，不如把编号写清楚——与审批那一格同一立场（D81）。
 * 单选那一格收到两个编号时按自由回答记，不把人选过的那一条悄悄丢掉一半。
 */
export function answerOf(question: AskQuestion, text: string): AskAnswer | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const tokens = trimmed.split(/[,，、\s]+/).filter((one) => one !== '');
  const within = question.options.length > 0
    && tokens.every((one) => /^\d+$/.test(one))
    && tokens.every((one) => Number(one) >= 1 && Number(one) <= question.options.length)
    && (question.multiSelect || tokens.length === 1);
  if (!within) return { id: question.id, selected: [], custom: trimmed };
  return { id: question.id, selected: [...new Set(tokens.map((one) => question.options[Number(one) - 1].label))] };
}
