// 交出去的那一样文本：终端标题上那一串（D81 边界二：不写进会话记录）。
// 导出的那一份 markdown 在宿主那一侧（`src/host/export.ts`，方案 6A），两个界面共用那一份。

// 标题那一串来自模型名与项目根这类位置，去掉能终止转义序列的控制字符与双向格式码：
// 一串带 ESC 或 BEL 的文本写进标题就等于在替这个终端写它自己的指令。
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u200E-\u200F\u202A-\u202E\u2066-\u2069]/g;

export function titleText({ model, boundary, sessionId }: { model?: string; boundary?: string; sessionId: string }): string {
  const parts = [model, boundary, sessionId.slice(0, 8)].filter((part) => typeof part === 'string' && part !== '');
  return parts.join(' · ').replace(CONTROL, '').slice(0, 120);
}

/** 终端标题走 OSC 那一条：`\x1B]0;<那一串>\x1B\\`。收尾用 ST 而不是 BEL，与那一串里可能有的字符都不冲突。 */
export function titleEscape(title: string): string {
  return `\u001B]0;${title}\u001B\\`;
}
