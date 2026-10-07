// 终端那一份键位表：一记按键落的是哪一个动作，与画面上说出来的一串字，读的是同一处（方案 6.1）。
// 动作名是稳定标识；个人覆盖换掉的是那一个动作的键，动作名不动。
// 范围那一格是必需的：Enter 在输入里是发送，在路径候选里是选中，在会话列表里是接过来——同一记键，三处各有各的落。
// 同一范围里撞在一起是冲突，要报出来；不同范围共用一记键不算，但要说清各自落在哪儿。

/** Ink 交回的那一记按键的形状（只列这一处用到的那几格）。 */
export type InkKey = {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  escape?: boolean;
  return?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
};

export type KeyView = '全局' | '输入' | '补全清单' | '路径候选' | '反查' | '会话列表' | '完整历史' | '审批';

export type TerminalAction =
  | 'quit' | 'expand-or-history' | 'editor' | 'search-open' | 'interrupt'
  | 'send' | 'newline' | 'newline-alt' | 'history-up' | 'history-down' | 'history-up-shift' | 'history-down-shift' | 'queue-recall' | 'queue-recall-alt'
  | 'complete' | 'complete-up' | 'complete-down' | 'complete-close'
  | 'pick-path' | 'pick-path-alt' | 'path-up' | 'path-down' | 'path-close'
  | 'search-pick' | 'search-up' | 'search-down' | 'search-cycle' | 'search-back' | 'search-back-alt' | 'search-close'
  | 'list-open' | 'list-up' | 'list-down' | 'list-page-up' | 'list-page-down' | 'list-first' | 'list-last' | 'list-close'
  | 'view-up' | 'view-down' | 'view-page-up' | 'view-page-down' | 'view-top' | 'view-bottom'
  | 'mark-up' | 'mark-down' | 'copy-selection' | 'view-close'
  | 'approval-cancel' | 'approve' | 'deny'
  | 'approval-up' | 'approval-down' | 'approval-page-up' | 'approval-page-down' | 'approval-top' | 'approval-bottom';

export type Binding = { readonly spec: string; readonly view: KeyView; readonly label: string };

export const KEYMAP: Readonly<Record<TerminalAction, Binding>> = {
  'quit': { spec: 'ctrl+c', view: '全局', label: '退出界面' },
  'expand-or-history': { spec: 'ctrl+o', view: '全局', label: '打开完整历史浏览；审批框开着时展开或收起那一段改动' },
  'editor': { spec: 'ctrl+g', view: '全局', label: '把草稿交给 EDITOR 或 VISUAL 指的那一个编辑器' },
  'search-open': { spec: 'ctrl+r', view: '全局', label: '起一次输入历史反查' },
  'interrupt': { spec: 'escape', view: '全局', label: '打断这一轮；排着的几条一起停下' },

  'send': { spec: 'enter', view: '输入', label: '发送这一句；跑着的时候排到后面' },
  'newline': { spec: 'shift+enter', view: '输入', label: '换行' },
  'newline-alt': { spec: 'ctrl+n', view: '输入', label: '换行（与 Shift+Enter 同一件事）' },
  'history-up': { spec: 'arrowup', view: '输入', label: '往上：草稿有多行时移动光标，单行时翻本机输入历史' },
  'history-down': { spec: 'arrowdown', view: '输入', label: '往下：草稿有多行时移动光标，已经在历史里时翻回去' },
  // 有些终端把带 Shift 的上下键报成另一串（CSI u），与光按上下键不是同一记。两条都收，光标才会在两种终端里都动得了。
  'history-up-shift': { spec: 'shift+arrowup', view: '输入', label: '往上（带 Shift 的那一记，与 ↑ 同一件事）' },
  'history-down-shift': { spec: 'shift+arrowdown', view: '输入', label: '往下（带 Shift 的那一记，与 ↓ 同一件事）' },
  'queue-recall': { spec: 'backspace', view: '输入', label: '草稿空着时收回排着的最后一条' },
  'queue-recall-alt': { spec: 'delete', view: '输入', label: '草稿空着时收回排着的最后一条（与退格同一件事）' },

  'complete': { spec: 'tab', view: '补全清单', label: '补全那一条命令' },
  'complete-up': { spec: 'arrowup', view: '补全清单', label: '选上一条命令' },
  'complete-down': { spec: 'arrowdown', view: '补全清单', label: '选下一条命令' },
  'complete-close': { spec: 'escape', view: '补全清单', label: '收起这份清单' },

  'pick-path': { spec: 'enter', view: '路径候选', label: '选中那一条文件，不发送' },
  'pick-path-alt': { spec: 'tab', view: '路径候选', label: '选中那一条文件（与 Enter 同一件事）' },
  'path-up': { spec: 'arrowup', view: '路径候选', label: '换到上一条文件' },
  'path-down': { spec: 'arrowdown', view: '路径候选', label: '换到下一条文件' },
  'path-close': { spec: 'escape', view: '路径候选', label: '收起这一个词的候选' },

  'search-pick': { spec: 'enter', view: '反查', label: '把选中那一条交回草稿' },
  'search-up': { spec: 'arrowup', view: '反查', label: '换到上一条命中' },
  'search-down': { spec: 'arrowdown', view: '反查', label: '换到下一条命中' },
  'search-cycle': { spec: 'ctrl+r', view: '反查', label: '接着往下换一条命中' },
  'search-back': { spec: 'backspace', view: '反查', label: '删掉查询串最后那一个字；查询串空着时退出反查' },
  'search-back-alt': { spec: 'delete', view: '反查', label: '删掉查询串最后那一个字（与退格同一件事）' },
  'search-close': { spec: 'escape', view: '反查', label: '退出反查，草稿不动' },

  'list-open': { spec: 'enter', view: '会话列表', label: '接住选中那一份会话' },
  'list-up': { spec: 'arrowup', view: '会话列表', label: '往上选一份会话' },
  'list-down': { spec: 'arrowdown', view: '会话列表', label: '往下选一份会话' },
  'list-page-up': { spec: 'pageup', view: '会话列表', label: '往上翻一屏会话' },
  'list-page-down': { spec: 'pagedown', view: '会话列表', label: '往下翻一屏会话' },
  'list-first': { spec: 'home', view: '会话列表', label: '跳到第一份会话' },
  'list-last': { spec: 'end', view: '会话列表', label: '跳到最后一份会话' },
  'list-close': { spec: 'escape', view: '会话列表', label: '收起这份列表' },

  'view-up': { spec: 'arrowup', view: '完整历史', label: '往上走一行' },
  'view-down': { spec: 'arrowdown', view: '完整历史', label: '往下走一行' },
  'view-page-up': { spec: 'pageup', view: '完整历史', label: '往上翻一屏' },
  'view-page-down': { spec: 'pagedown', view: '完整历史', label: '往下翻一屏' },
  'view-top': { spec: 'home', view: '完整历史', label: '跳到开头' },
  'view-bottom': { spec: 'end', view: '完整历史', label: '跳到末尾' },
  'mark-up': { spec: 'shift+arrowup', view: '完整历史', label: '把选中的范围往上扩' },
  'mark-down': { spec: 'shift+arrowdown', view: '完整历史', label: '把选中的范围往下扩' },
  'copy-selection': { spec: 'ctrl+y', view: '完整历史', label: '复制选中的那几行' },
  'view-close': { spec: 'escape', view: '完整历史', label: '关掉这份视图，回到原来的草稿' },

  'approval-cancel': { spec: 'escape', view: '审批', label: '取消这一轮（不允许这一次调用）' },
  'approve': { spec: 'y', view: '审批', label: '允许这一次调用' },
  'deny': { spec: 'n', view: '审批', label: '不允许这一次调用' },
  'approval-up': { spec: 'arrowup', view: '审批', label: '在那一段改动里往上走一行' },
  'approval-down': { spec: 'arrowdown', view: '审批', label: '在那一段改动里往下走一行' },
  'approval-page-up': { spec: 'pageup', view: '审批', label: '在那一段改动里往上翻一屏' },
  'approval-page-down': { spec: 'pagedown', view: '审批', label: '在那一段改动里往下翻一屏' },
  'approval-top': { spec: 'home', view: '审批', label: '跳到那一段改动的开头' },
  'approval-bottom': { spec: 'end', view: '审批', label: '跳到那一段改动的末尾' },
};

// Ink 对修饰键交回的是那一键自己的名字（`Control`、`Meta`）：光按住修饰键不是一记能用光自己的绑定。
const BARE_MODIFIERS = ['control', 'shift', 'alt', 'meta'];
const MODIFIERS = ['ctrl', 'shift', 'alt', 'meta'];

// 一记按键在界面上的写法：画面说「PageUp」而表里写的是 `pageup`，这一处负责那一张对照。
const KEY_NAMES: Readonly<Record<string, string>> = {
  enter: 'Enter', escape: 'Esc', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', ' ': '空格',
};

/** 把 Ink 交回的这一记按键读成规范写法（`ctrl+r`、`shift+enter`、`arrowup`）。 */
export function specOf(input: string, key: InkKey): string | null {
  const named = key.escape === true ? 'escape'
    : key.pageUp === true ? 'pageup' : key.pageDown === true ? 'pagedown'
      : key.upArrow === true ? 'arrowup' : key.downArrow === true ? 'arrowdown'
        : key.leftArrow === true ? 'arrowleft' : key.rightArrow === true ? 'arrowright'
          : key.home === true ? 'home' : key.end === true ? 'end'
            : key.return === true ? 'enter' : key.tab === true ? 'tab'
              : key.backspace === true ? 'backspace' : key.delete === true ? 'delete' : null;
  if (named !== null) {
    const head = [key.ctrl === true ? 'ctrl' : null, key.shift === true ? 'shift' : null, key.meta === true ? 'meta' : null]
      .filter((mod): mod is string => mod !== null);
    return [...head, named].join('+');
  }
  const typed = input.toLowerCase();
  if (BARE_MODIFIERS.includes(typed)) return null;
  // 带 Ctrl 的那一些认的是字母本身：终端里 Ctrl+Shift+A 与 Ctrl+A 交回的是同一串，不分出这一层就不写进表。
  if (key.ctrl === true && input.length === 1) return `ctrl+${typed}`;
  if (input.trim() === '') return null;
  return typed;
}

export function defaultSpecs(): Record<TerminalAction, string> {
  return Object.fromEntries(Object.entries(KEYMAP).map(([action, binding]) => [action, binding.spec])) as Record<TerminalAction, string>;
}

// 当前那一份：个人覆盖接进来之后换的是这一格的来源，读它的那两处（按键落点与画面说法）跟着一起换。
export const CURRENT = defaultSpecs();

/** 这一记按键落的是不是那一个动作。调用那一处已经站在哪个范围里，这里只比键。 */
export function hit(action: TerminalAction, input: string, key: InkKey, bindings: Record<TerminalAction, string> = CURRENT): boolean {
  return specOf(input, key) === bindings[action];
}

/** 把几记动作的键拼成一句提示里的写法（`PageUp/PageDown`）。提示与按键落的读的是同一份表（方案 6.1）。 */
export function keyHint(...actions: TerminalAction[]): string {
  return actions.map((action) => formatKeys(CURRENT[action])).join('/');
}

/** 一记按键的规范写法换成界面上的那一串（`ctrl+shift+a` 换成 `Ctrl+Shift+A`）。读不懂的写法原样交回。 */
export function formatKeys(spec: string): string {
  const parts = spec.trim().toLowerCase().split('+');
  if (parts.length === 0 || parts.some((part) => part === '')) return spec;
  const mods = parts.slice(0, -1);
  if (mods.some((mod) => !MODIFIERS.includes(mod))) return spec;
  const key = parts[parts.length - 1]!;
  const head = mods.map((mod) => (mod === 'meta' ? 'Cmd' : mod[0]!.toUpperCase() + mod.slice(1)));
  const tail = KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : null);
  return tail === null ? spec : [...head, tail].join('+');
}

/** 同一个范围里两记键撞在一起时交回那两动作的名字；不同范围共用一记键不算撞。 */
export function conflictsIn(view: KeyView, bindings: Record<TerminalAction, string>): [TerminalAction, TerminalAction][] {
  const seen = new Map<string, TerminalAction>();
  const found: [TerminalAction, TerminalAction][] = [];
  for (const [action, binding] of Object.entries(KEYMAP) as [TerminalAction, Binding][]) {
    if (binding.view !== view) continue;
    const earlier = seen.get(bindings[action]);
    if (earlier !== undefined) found.push([earlier, action]);
    else seen.set(bindings[action], action);
  }
  return found;
}
