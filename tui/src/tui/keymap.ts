// 键位表将按键映射到动作，界面提示和实际操作共用此定义。
// 动作名保持稳定，用户覆盖只更改对应按键。
// 绑定按作用范围区分；同一范围内冲突，不同范围可以复用同一按键。

/** Ink 返回的按键事件中本模块使用的字段。 */
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

export type KeyView = '全局' | '输入' | '补全清单' | '路径候选' | '反查' | '会话列表' | '完整历史' | '审批' | '提问' | '面板';

export type TerminalAction =
  | 'quit' | 'expand-or-history' | 'editor' | 'search-open' | 'interrupt' | 'model-picker' | 'mode-picker' | 'policy-picker'
  | 'send' | 'newline' | 'newline-alt' | 'history-up' | 'history-down' | 'history-up-shift' | 'history-down-shift' | 'queue-recall' | 'queue-recall-alt' | 'undo-draft' | 'redo-draft'
  | 'complete' | 'complete-up' | 'complete-down' | 'complete-close'
  | 'pick-path' | 'pick-path-alt' | 'path-up' | 'path-down' | 'path-close'
  | 'search-pick' | 'search-up' | 'search-down' | 'search-cycle' | 'search-back' | 'search-back-alt' | 'search-close'
  | 'list-open' | 'list-up' | 'list-down' | 'list-page-up' | 'list-page-down' | 'list-first' | 'list-last' | 'list-close'
  | 'view-up' | 'view-down' | 'view-page-up' | 'view-page-down' | 'view-top' | 'view-bottom'
  | 'mark-up' | 'mark-down' | 'copy-selection' | 'view-close'
  | 'approval-cancel' | 'approve' | 'deny'
  | 'approval-up' | 'approval-down' | 'approval-page-up' | 'approval-page-down' | 'approval-top' | 'approval-bottom'
  | 'question-back'
  | 'panel-up' | 'panel-down' | 'panel-page-up' | 'panel-page-down' | 'panel-left' | 'panel-right' | 'panel-select' | 'panel-close';

export type Binding = { readonly spec: string; readonly view: KeyView; readonly label: string };

export const ENGLISH_VIEWS: Record<KeyView, string> = {
  全局: 'Global', 输入: 'Composer', 补全清单: 'Commands', 路径候选: 'Files',
  反查: 'Input history', 会话列表: 'Sessions', 完整历史: 'Transcript', 审批: 'Approvals', 提问: 'Questions', 面板: 'Panels',
};

export const ENGLISH_LABELS: Record<TerminalAction, string> = {
  quit: 'Exit', 'expand-or-history': 'Browse transcript or expand approval details',
  editor: 'Edit draft in VISUAL or EDITOR', 'search-open': 'Search input history', interrupt: 'Stop this turn and pause the queue',
  'model-picker': 'Select a model', 'mode-picker': 'Select a tool mode', 'policy-picker': 'Select an approval mode',
  'panel-up': 'Previous item or line', 'panel-down': 'Next item or line', 'panel-page-up': 'Previous page', 'panel-page-down': 'Next page',
  'panel-left': 'Previous help category', 'panel-right': 'Next help category', 'panel-select': 'Confirm selection', 'panel-close': 'Close panel and keep the draft',
  send: 'Send, or queue while running', newline: 'New line', 'newline-alt': 'New line',
  'history-up': 'Move up, or recall earlier input on a single line', 'history-down': 'Move down, or recall newer input',
  'history-up-shift': 'Move up', 'history-down-shift': 'Move down',
  'queue-recall': 'Recover the last queued message when the draft is empty', 'queue-recall-alt': 'Recover the last queued message',
  'undo-draft': 'Undo draft edit', 'redo-draft': 'Redo draft edit',
  complete: 'Complete command', 'complete-up': 'Previous command', 'complete-down': 'Next command', 'complete-close': 'Close suggestions',
  'pick-path': 'Insert the selected file without sending', 'pick-path-alt': 'Insert selected file',
  'path-up': 'Previous file', 'path-down': 'Next file', 'path-close': 'Close file suggestions',
  'search-pick': 'Restore the selected input to the draft', 'search-up': 'Previous match', 'search-down': 'Next match',
  'search-cycle': 'Next match', 'search-back': 'Delete a query character, or close when empty', 'search-back-alt': 'Delete a query character', 'search-close': 'Close search and keep the draft',
  'list-open': 'Resume selected session', 'list-up': 'Previous session', 'list-down': 'Next session',
  'list-page-up': 'Previous page', 'list-page-down': 'Next page', 'list-first': 'First session', 'list-last': 'Last session', 'list-close': 'Close session list',
  'view-up': 'Move up a line', 'view-down': 'Move down a line', 'view-page-up': 'Previous page', 'view-page-down': 'Next page',
  'view-top': 'Go to start', 'view-bottom': 'Go to end', 'mark-up': 'Extend selection up', 'mark-down': 'Extend selection down',
  'copy-selection': 'Copy selection', 'view-close': 'Close transcript and keep the draft',
  'approval-cancel': 'Cancel this turn', approve: 'Allow this call', deny: 'Deny this call',
  'approval-up': 'Scroll up a line', 'approval-down': 'Scroll down a line', 'approval-page-up': 'Previous page', 'approval-page-down': 'Next page',
  'approval-top': 'Go to start', 'approval-bottom': 'Go to end', 'question-back': 'Edit the previous answer when the draft is empty',
};

export const KEYMAP: Readonly<Record<TerminalAction, Binding>> = {
  'quit': { spec: 'ctrl+c', view: '全局', label: '退出界面' },
  'expand-or-history': { spec: 'ctrl+o', view: '全局', label: '打开完整历史浏览；审批框开着时展开或收起那一段改动' },
  'editor': { spec: 'ctrl+g', view: '全局', label: '把草稿交给 EDITOR 或 VISUAL 指的那一个编辑器' },
  'search-open': { spec: 'ctrl+r', view: '全局', label: '起一次输入历史反查' },
  'interrupt': { spec: 'escape', view: '全局', label: '打断这一轮；排着的几条一起停下' },
  'model-picker': { spec: 'ctrl+p', view: '全局', label: '选择模型' },
  'mode-picker': { spec: 'ctrl+t', view: '全局', label: '选择工具模式' },
  'policy-picker': { spec: 'ctrl+a', view: '全局', label: '选择审批方式' },

  'panel-up': { spec: 'arrowup', view: '面板', label: '上一项或上一行' },
  'panel-down': { spec: 'arrowdown', view: '面板', label: '下一项或下一行' },
  'panel-page-up': { spec: 'pageup', view: '面板', label: '上一页' },
  'panel-page-down': { spec: 'pagedown', view: '面板', label: '下一页' },
  'panel-left': { spec: 'arrowleft', view: '面板', label: '上一个帮助分类' },
  'panel-right': { spec: 'arrowright', view: '面板', label: '下一个帮助分类' },
  'panel-select': { spec: 'enter', view: '面板', label: '确认选择' },
  'panel-close': { spec: 'escape', view: '面板', label: '关闭面板并保留草稿' },

  'send': { spec: 'enter', view: '输入', label: '发送这一句；跑着的时候排到后面' },
  'newline': { spec: 'shift+enter', view: '输入', label: '换行' },
  'newline-alt': { spec: 'ctrl+n', view: '输入', label: '换行（与 Shift+Enter 同一件事）' },
  'history-up': { spec: 'arrowup', view: '输入', label: '往上：草稿有多行时移动光标，单行时翻本机输入历史' },
  'history-down': { spec: 'arrowdown', view: '输入', label: '往下：草稿有多行时移动光标，已经在历史里时翻回去' },
  // 兼容终端对 Shift+方向键使用的 CSI u 编码。
  'history-up-shift': { spec: 'shift+arrowup', view: '输入', label: '往上（带 Shift 的那一记，与 ↑ 同一件事）' },
  'history-down-shift': { spec: 'shift+arrowdown', view: '输入', label: '往下（带 Shift 的那一记，与 ↓ 同一件事）' },
  'queue-recall': { spec: 'backspace', view: '输入', label: '草稿空着时收回排着的最后一条' },
  'queue-recall-alt': { spec: 'delete', view: '输入', label: '草稿空着时收回排着的最后一条（与退格同一件事）' },
  // raw mode 下 Ctrl+Z 会作为按键事件交给应用，不触发 POSIX 作业控制。
  'undo-draft': { spec: 'ctrl+z', view: '输入', label: '退回草稿的上一次改动' },
  'redo-draft': { spec: 'ctrl+y', view: '输入', label: '把刚退回的那一段再拿回来' },

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

  // 问题面板中 Enter 提交答案；草稿非空时保留左方向键的光标移动行为。
  'question-back': { spec: 'arrowleft', view: '提问', label: '草稿空着时回到上一题，把刚才写的答话放回草稿里改' },
};

// 单独按下 `Control` 或 `Meta` 不构成有效快捷键。
const BARE_MODIFIERS = ['control', 'shift', 'alt', 'meta'];
const MODIFIERS = ['ctrl', 'shift', 'alt', 'meta'];

// 将规范按键名称映射为界面显示名称，例如 `pageup` 显示为 `PageUp`。
const KEY_NAMES: Readonly<Record<string, string>> = {
  enter: 'Enter', escape: 'Esc', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', ' ': '空格',
};

/** 将 Ink 按键事件转换为规范名称，例如 `ctrl+r`、`shift+enter` 和 `arrowup`。 */
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
  // 终端可能将 Ctrl+Shift+字母和 Ctrl+字母编码为相同事件，因此不单独登记这类组合。
  if (key.ctrl === true && input.length === 1) return `ctrl+${typed}`;
  if (input.trim() === '') return null;
  return typed;
}

export function defaultSpecs(): Record<TerminalAction, string> {
  return Object.fromEntries(Object.entries(KEYMAP).map(([action, binding]) => [action, binding.spec])) as Record<TerminalAction, string>;
}

// 当前生效的键位表；用户覆盖同时影响按键处理和界面提示。
// 覆盖只在 `applyOverrides` 中应用，避免不同调用点使用不一致的绑定。
export const CURRENT = defaultSpecs();

function isTerminalAction(value: string): value is TerminalAction {
  return Object.hasOwn(KEYMAP, value);
}

/** 将用户输入的键名转换为规范格式；无法识别时返回 null。 */
export function parseSpec(text: string): string | null {
  const parts = text.trim().toLowerCase().split('+').map((part) => part.trim());
  if (parts.some((part) => part === '')) return null;
  const key = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  if (mods.some((mod) => !MODIFIERS.includes(mod))) return null;
  const aliases: Record<string, string> = { esc: 'escape', return: 'enter', arrowup: 'uparrow', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', pgup: 'pageup', pgdn: 'pagedown', del: 'delete', space: ' ' };
  const named = aliases[key] ?? key;
  if (BARE_MODIFIERS.includes(named) || !(KEY_NAMES[named] !== undefined || named.length === 1)) return null;
  return [...mods, named].join('+');
}

/** 应用用户键位覆盖；返回未知动作和无效按键，其他有效绑定照常应用。 */
export function applyOverrides(overrides: Record<string, string>): { readonly applied: TerminalAction[]; readonly refused: string[] } {
  const applied: TerminalAction[] = [];
  const refused: string[] = [];
  for (const [action, text] of Object.entries(overrides)) {
    if (!isTerminalAction(action)) { refused.push(`${action}（表里没有这一个动作）`); continue; }
    const spec = parseSpec(text);
    if (spec === null) { refused.push(`${action}: ${text}`); continue; }
    CURRENT[action] = spec;
    applied.push(action);
  }
  return { applied, refused };
}

/** 返回指定作用范围内发生冲突的快捷键绑定。 */
export function conflictsNow(view: KeyView): [TerminalAction, TerminalAction][] {
  return conflictsIn(view, CURRENT);
}

/** 检查按键是否与指定动作匹配；调用方负责选择作用范围。 */
export function hit(action: TerminalAction, input: string, key: InkKey, bindings: Record<TerminalAction, string> = CURRENT): boolean {
  return specOf(input, key) === bindings[action];
}

/** 将多个动作的按键合并为提示文本，例如 `PageUp/PageDown`。 */
export function keyHint(...actions: TerminalAction[]): string {
  return actions.map((action) => formatKeys(CURRENT[action])).join('/');
}

/** 将规范按键名转换为界面显示格式；未知名称原样返回。 */
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

/** 返回同一作用范围内共享按键的动作对；不同范围的同键绑定不算冲突。 */
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
