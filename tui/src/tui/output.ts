// 终端标题通过控制序列写出，不进入会话记录。
// Markdown 导出由 Host 统一处理，CLI/TUI 和 Desktop 共用该实现。

// 写入终端标题前移除控制字符和双向格式字符，防止模型名或路径注入终端控制序列。
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u200E-\u200F\u202A-\u202E\u2066-\u2069]/g;

export function titleText({ model, boundary, sessionId }: { model?: string; boundary?: string; sessionId: string }): string {
  const parts = [model, boundary, sessionId.slice(0, 8)].filter((part) => typeof part === 'string' && part !== '');
  return parts.join(' · ').replace(CONTROL, '').slice(0, 120);
}

/** 使用 OSC 设置终端标题，并以 ST 结束控制序列，避免与标题内容冲突。 */
export function titleEscape(title: string): string {
  return `\u001B]0;${title}\u001B\\`;
}
