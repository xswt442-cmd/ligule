// 队列预览截短为单行，避免长消息撑开输入区。
export function queuedLine(text: string, limit = 64): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
