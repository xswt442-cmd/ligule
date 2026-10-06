// 键盘层的那一格判断：按住修饰键的这一记落下的是哪一个动作。
// 输入框里的普通按键不在这里管；Ctrl+C 也不动，那是复制选中的文字。
export type Hotkey = 'palette' | 'sidebar' | 'copy' | null;

export function hotkeyOf(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): Hotkey {
  if (event.ctrlKey !== true && event.metaKey !== true) return null;
  const key = event.key.toLowerCase();
  if (key === 'k') return 'palette';
  if (key === 'b') return 'sidebar';
  if (key === 'c' && event.shiftKey === true) return 'copy';
  return null;
}
