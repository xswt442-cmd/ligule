// 终端界面的命令表与候选清单（D81）。这里只做「画哪几条、命中哪一条」这类纯计算。
// 命令的内容一律来自宿主：提示模板由宿主交出、展开也归宿主（D24、D49），界面不留第二份事实源。

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
const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
];

export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    width += WIDE_RANGES.some(([from, to]) => code >= from && code <= to) ? 2 : 1;
  }
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
