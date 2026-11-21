// 队列预览截短为单行，避免长消息撑开输入区。
export function queuedLine(text: string, limit = 64): string {
  const single = text.replace(/\s*\r?\n\s*/gu, ' ');
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}
