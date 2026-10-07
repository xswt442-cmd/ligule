// 桌面的键位层：一记按键落的是哪一个动作，与界面说出来的一串字，读的是同一份表。
// 动作名是稳定标识；个人覆盖换掉的是那一个动作的键，动作名不动（方案 6.1 已定的那一条）。
// 两头同源才说不出一键两义：提示写着 Ctrl+K 而实际落的是别的键，这种情况在这一层里进不来。

export type KeyAction = 'palette' | 'sidebar' | 'copy-answer' | 'interrupt'
  | 'send' | 'send-alt' | 'newline' | 'history-older' | 'history-newer'
  | 'pick-candidate' | 'complete-candidate' | 'candidate-older' | 'candidate-newer' | 'hide-candidate';

// 视图那一格说的是一记键在哪个范围里落。同一个范围里两记键撞在一起是冲突；
// 不同范围共用一记键（Enter 在输入坞是发送、在候选清单里是选中）不算，但要说清各自落在哪儿。
export type KeyView = '窗口' | '输入坞' | '候选清单';

export type KeyEvent = { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean };

export type Binding = { readonly spec: string; readonly view: KeyView; readonly label: string };

// 修饰键的先后固定写在这一处：认键与说键都按这一种形状，换键的人照同一串拼。
const MODIFIERS = ['ctrl', 'shift', 'alt', 'meta'] as const;
// 光按住修饰键时浏览器交回的是那一个键自己的名字（`Control`、`Meta`），它不是一记能用光自己的绑定。
const BARE_MODIFIERS = ['control', 'shift', 'alt', 'meta'];

// 一记按键在界面上的写法：Ctrl+Shift+C、Enter、↑。
const KEY_NAMES: Readonly<Record<string, string>> = {
  enter: 'Enter', escape: 'Esc', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', ' ': '空格',
};

export const KEYMAP: Readonly<Record<KeyAction, Binding>> = {
  'palette': { spec: 'ctrl+k', view: '窗口', label: '开命令面板' },
  'sidebar': { spec: 'ctrl+b', view: '窗口', label: '收左侧栏' },
  'copy-answer': { spec: 'ctrl+shift+c', view: '窗口', label: '复制最后那条回答' },
  'interrupt': { spec: 'escape', view: '窗口', label: '收起开着的那一层；都收完才打断这一轮' },
  'send': { spec: 'enter', view: '输入坞', label: '发送这一句；跑着的时候排到后面' },
  'send-alt': { spec: 'ctrl+enter', view: '输入坞', label: '发送（与 Enter 同一件事）' },
  'newline': { spec: 'shift+enter', view: '输入坞', label: '换行' },
  'history-older': { spec: 'arrowup', view: '输入坞', label: '翻本机输入历史：空草稿上往上' },
  'history-newer': { spec: 'arrowdown', view: '输入坞', label: '翻本机输入历史：已经翻起来时往下' },
  'pick-candidate': { spec: 'enter', view: '候选清单', label: '选中那一条文件候选，不发送' },
  'complete-candidate': { spec: 'tab', view: '候选清单', label: '选中那一条文件候选（与 Enter 同一件事）' },
  'candidate-older': { spec: 'arrowup', view: '候选清单', label: '换到上一条候选' },
  'candidate-newer': { spec: 'arrowdown', view: '候选清单', label: '换到下一条候选' },
  'hide-candidate': { spec: 'escape', view: '候选清单', label: '收起这一个词的候选' },
};

/** 一记按键的规范写法（`ctrl+shift+c`）换成界面上的那一串（`Ctrl+Shift+C`）。读不懂的写法交回原样。 */
export function formatKeys(spec: string): string {
  const parts = spec.trim().toLowerCase().split('+');
  if (parts.length === 0 || parts.some((part) => part === '')) return spec;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (mods.some((mod) => !MODIFIERS.includes(mod as typeof MODIFIERS[number]))) return spec;
  const head = mods.map((mod) => (mod === 'meta' ? 'Cmd' : mod[0]!.toUpperCase() + mod.slice(1)));
  const tail = KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : null);
  if (tail === null) return spec;
  return [...head, tail].join('+');
}

/** 这一记按键落的是哪一个动作。`view` 只收那一个范围里的绑定，所以候选清单开着时 Enter 认成选中而不是发送。 */
export function actionOf(event: KeyEvent, view: KeyView, bindings: Record<KeyAction, string> = defaultSpecs()): KeyAction | null {
  const typed = specOf(event);
  if (typed === null) return null;
  for (const [action, binding] of Object.entries(KEYMAP) as [KeyAction, Binding][]) {
    if (binding.view === view && bindings[action] === typed) return action;
  }
  return null;
}

/** 把一记按键读成规范写法：修饰键按固定先后排，最后一格是键名。字母不分大小写，Cmd 与 Ctrl 认成同一记修饰键。 */
export function specOf(event: KeyEvent): string | null {
  const named = event.key.toLowerCase();
  if (BARE_MODIFIERS.includes(named)) return null;
  const head = [
    event.ctrlKey === true || event.metaKey === true ? 'ctrl' : null,
    event.shiftKey === true ? 'shift' : null,
    event.altKey === true ? 'alt' : null,
  ].filter((mod): mod is string => mod !== null);
  return [...head, named].join('+');
}

export function defaultSpecs(): Record<KeyAction, string> {
  return Object.fromEntries(Object.entries(KEYMAP).map(([action, binding]) => [action, binding.spec])) as Record<KeyAction, string>;
}

/** 同一个范围里两记键撞在一起时交回那两动作的名字；不同范围共用一记键不算撞。 */
export function conflictsIn(view: KeyView, bindings: Record<KeyAction, string>): [KeyAction, KeyAction][] {
  const seen = new Map<string, KeyAction>();
  const found: [KeyAction, KeyAction][] = [];
  for (const [action, binding] of Object.entries(KEYMAP) as [KeyAction, Binding][]) {
    if (binding.view !== view) continue;
    const spec = bindings[action];
    const earlier = seen.get(spec);
    if (earlier !== undefined) found.push([earlier, action]);
    else seen.set(spec, action);
  }
  return found;
}

// 输入法还在拼的那一段：这一记按键属于候选词那一层，不是界面要听的那一条。
// `isComposing` 是标准的那一格，229 是各浏览器在组合期间一贯交回的 keyCode。
export function isComposing(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
