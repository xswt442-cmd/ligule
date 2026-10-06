// 键盘层的那一格判断：按住修饰键的这一记落下的是哪一个动作。
// 输入框里的普通按键不在这里管；Ctrl+C 也不动，那是复制选中的文字。
export type Hotkey = 'palette' | 'sidebar' | 'copy' | null;

// 输入法还在拼的那一段：这一记按键属于候选词那一层，不是界面要听的那一条。
// `isComposing` 是标准的那一格，229 是各浏览器在组合期间一贯交回的 keyCode。
export function isComposing(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

export function hotkeyOf(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): Hotkey {
  if (event.ctrlKey !== true && event.metaKey !== true) return null;
  const key = event.key.toLowerCase();
  if (key === 'k') return 'palette';
  if (key === 'b') return 'sidebar';
  if (key === 'c' && event.shiftKey === true) return 'copy';
  return null;
}
