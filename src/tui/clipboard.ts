export { clipboardPayload, copyToClipboard, writeClipboard, type ClipboardResult } from '../capability/clipboard.js';

// 复制的是最近那一条回答：记录里最后一条有正文的 assistant 事件，流式期间那半截不算（那条还没落盘）。
export function lastAnswer(events: readonly { kind: string; text?: string }[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'assistant' && typeof event.text === 'string' && event.text !== '') return event.text;
  }
  return '';
}
