// 终端界面的命令表与候选清单（D81）。这里只做「画哪几条、命中哪一条」这类纯计算。
// 命令的内容一律来自宿主：提示模板由宿主交出、展开也归宿主（D24、D49），界面不留第二份事实源。
import stringWidth from 'string-width';
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
export const UI_COMMANDS: readonly UiCommand[] = Object.freeze([
  { name: 'help', usage: '/help', text: '列出命令与按键', hint: '', whenRunning: true },
  { name: 'mode', usage: '/mode [名字]', text: '显示当前模式，或切换到另一个名字', hint: '[名字]', whenRunning: true },
  { name: 'status', usage: '/status', text: '显示模式、档位、拒绝计数与记录条数', hint: '', whenRunning: true },
  { name: 'compact', usage: '/compact', text: '现在就把靠前的那一段压成一份摘要（要写出 limits.contextTokens）', hint: '', whenRunning: true },
  { name: 'tools', usage: '/tools', text: '列出这次运行装了哪些工具', hint: '', whenRunning: true },
  { name: 'show', usage: '/show [序号]', text: '把记录里那一条的完整内容画出来，不带序号收起', hint: '[序号]', whenRunning: true },
  { name: 'sub', usage: '/sub [序号]', text: '画出那一次派生执行的整份支线记录，不带序号收起', hint: '[序号]', whenRunning: true },
  { name: 'new', usage: '/new', text: '开一份新会话，画面上方的历史留在终端里', hint: '', whenRunning: false },
  { name: 'copy', usage: '/copy', text: '把最近那一条回答放进剪贴板', hint: '', whenRunning: true },
  { name: 'export', usage: '/export <路径>', text: '把这一份记录写成 markdown，派生支线各另写一份', hint: '<路径>', whenRunning: true },
  { name: 'sessions', usage: '/sessions', text: '列出这个项目根下跑过的会话（时间是 UTC）', hint: '', whenRunning: true },
  { name: 'resume', usage: '/resume <id> [模式名]', text: '接上列出来的那一份会话，id 写开头几段就行；模式名是那一份清单改过之后显式指定用哪一份', hint: '<id> [模式名]', whenRunning: false },
  { name: 'quit', usage: '/quit', text: '退出（Ctrl+C 同样）', hint: '', whenRunning: true },
]);

export function findUiCommand(name: string): UiCommand | undefined {
  return UI_COMMANDS.find((command) => command.name === name);
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
): Candidate[] {
  if (!draft.startsWith('/')) return [];
  const typed = draft.slice(1);
  if (typed === '' || /\s/.test(typed)) return [];
  const prefix = typed.toLowerCase();
  const fromUi = UI_COMMANDS.filter((command) => command.name.startsWith(prefix)).map((command) => ({
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

// 放得下就并排，放不下整组往下一层，列与列之间按最宽那一行对齐。
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
  readonly unanswered: number;
  readonly truncatedBytes?: number;
  readonly error?: { readonly code: string; readonly detail: string };
}

/** 列表的条数上限：界面上一次画五十行已经把终端滚出一屏，U38 那条「要不要建索引」要的是日常使用的数字。 */
export const SESSION_ROWS = 20;

// 一栏一行。id 整串写出来，因为 `/resume` 后面要跟的就是这一串；时间是记录文件的写入时间，UTC。
export function sessionLines(listed: readonly SessionRow[], current = ''): string[] {
  if (listed.length === 0) return ['这个项目根下还没有跑过的会话'];
  return listed.map((item) => [
    item.updatedAt.slice(0, 19).replace('T', ' '),
    item.id,
    `${item.events} 条`,
    `mode:${item.mode?.name ?? '-'}`,
    item.unanswered > 0 ? `未收尾 ${item.unanswered} 次派发` : '',
    (item.truncatedBytes ?? 0) > 0 ? `尾行未完成 ${item.truncatedBytes} 字节` : '',
    item.error === undefined ? '' : `无法恢复：${item.error.code} · ${item.error.detail}`,
    item.id === current ? '← 正在这一份上' : '',
  ].filter((cell) => cell !== '').join('  '));
}

/** 前缀对上的那一份，或者一条说明为什么对不上——猜一份是把人带去他没选过的会话里。 */
export type SessionPick = { readonly id: string } | { readonly code: 'tui_session_ambiguous' | 'tui_session_not_listed' };

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
