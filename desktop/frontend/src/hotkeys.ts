// 按键到动作的映射和界面显示说明共用同一份绑定表。
// 动作名称保持稳定，用户覆盖只修改对应按键。
// 这样可以确保提示中的按键与实际触发的动作一致。

export type KeyAction = 'palette' | 'sidebar' | 'copy-answer' | 'interrupt'
  | 'send' | 'send-alt' | 'newline' | 'history-older' | 'history-newer'
  | 'pick-candidate' | 'complete-candidate' | 'candidate-older' | 'candidate-newer' | 'hide-candidate';

// `view` 指定按键作用范围。同一范围内的按键冲突；不同范围可以复用按键，例如输入区和候选列表都使用 Enter。
export type KeyView = '窗口' | '输入坞' | '候选清单';

export type KeyEvent = { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean };

export type Binding = { readonly spec: string; readonly view: KeyView; readonly label: string };

// 修饰键顺序固定，规范化和显示都使用同一顺序。
const MODIFIERS = ['ctrl', 'shift', 'alt', 'meta'] as const;
// 单独按下 `Control` 或 `Meta` 等修饰键不构成有效绑定。
const BARE_MODIFIERS = ['control', 'shift', 'alt', 'meta'];

// 按键的界面显示格式，例如 Ctrl+Shift+C、Enter 和方向键。
const KEY_NAMES: Readonly<Record<string, string>> = {
  enter: 'Enter', escape: 'Esc', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', ' ': 'Space',
};

export const KEYMAP: Readonly<Record<KeyAction, Binding>> = {
  'palette': { spec: 'ctrl+k', view: '窗口', label: '开命令面板' },
  'sidebar': { spec: 'ctrl+b', view: '窗口', label: '收起或展开左侧栏' },
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

/** 将规范按键名称（如 `ctrl+shift+c`）转换为界面格式（如 `Ctrl+Shift+C`）；无法识别时原样返回。 */
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

/** 根据按键和作用范围查找动作；候选列表打开时 Enter 对应选择，不对应发送。 */
export function actionOf(event: KeyEvent, view: KeyView, bindings: Record<KeyAction, string> = CURRENT): KeyAction | null {
  const typed = specOf(event);
  if (typed === null) return null;
  for (const [action, binding] of Object.entries(KEYMAP) as [KeyAction, Binding][]) {
    if (binding.view === view && bindings[action] === typed) return action;
  }
  return null;
}

/** 将按键转换为规范写法：修饰键使用固定顺序，字母不区分大小写，Cmd 与 Ctrl 统一处理。 */
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

// 当前生效的按键绑定；实际动作和界面说明都从此表读取。
export const CURRENT = defaultSpecs();

/** 将用户输入的按键名称转换为规范格式；无法识别时返回 null。 */
export function parseSpec(text: string): string | null {
  const parts = text.trim().toLowerCase().split('+').map((part) => part.trim());
  if (parts.some((part) => part === '')) return null;
  const mods = parts.slice(0, -1);
  if (mods.some((mod) => !MODIFIERS.includes(mod as typeof MODIFIERS[number]))) return null;
  const aliases: Record<string, string> = { esc: 'escape', return: 'enter', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', pgup: 'pageup', pgdn: 'pagedown', del: 'delete', space: ' ' };
  const key = aliases[parts[parts.length - 1]!] ?? parts[parts.length - 1]!;
  if (BARE_MODIFIERS.includes(key) || (KEY_NAMES[key] === undefined && key.length !== 1)) return null;
  return [...mods, key].join('+');
}

/** 应用用户覆盖前恢复默认绑定，再应用有效项，并报告未知动作或无效按键。 */
export function loadBindings(overrides: Record<string, string>): { readonly applied: number; readonly refused: string[] } {
  const defaults = defaultSpecs();
  for (const [action, spec] of Object.entries(defaults)) CURRENT[action as KeyAction] = spec;
  const refused: string[] = [];
  let applied = 0;
  for (const [action, value] of Object.entries(overrides)) {
    const key = action as KeyAction;
    if (!Object.prototype.hasOwnProperty.call(KEYMAP, action)) { refused.push(`${action}（表里没有这一个动作）`); continue; }
    const spec = typeof value === 'string' ? parseSpec(value) : null;
    if (spec === null) { refused.push(`${action}=${String(value)}`); continue; }
    CURRENT[key] = spec;
    applied += 1;
  }
  return { applied, refused };
}

/** 返回同一作用范围内按键冲突的动作；不同范围复用按键不算冲突。 */
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

// 输入法组合期间的按键由输入法处理，不交给界面快捷键。
// 浏览器通过 `isComposing` 或兼容用的 keyCode 229 标记组合状态。
export function isComposing(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

// 录制快捷键时暂停窗口级快捷操作，避免录入的按键同时触发动作。
let capturing = false;
export function setCapturing(on: boolean): void {
  capturing = on;
}
export function isCapturing(): boolean {
  return capturing;
}
