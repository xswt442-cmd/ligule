// 复制到剪贴板（第 46 步）：这一层只把一段文本交给本机那一个剪贴板程序，不读回来。
// Windows 上量过：交出去的是 UTF-8 时被按本机代码页读成另一串（「阶段」读成「闃舵」），
// 交带 BOM 的 UTF-16LE 时那两个字节留在剪贴板开头。所以交出去的是不带 BOM 的 UTF-16LE。
import { spawn } from 'node:child_process';

const BACKENDS: Partial<Record<NodeJS.Platform, { readonly program: string; readonly args: readonly string[] }>> = {
  win32: { program: 'clip', args: [] },
  darwin: { program: 'pbcopy', args: [] },
};

export type ClipboardResult =
  | { readonly program: string }
  | { readonly code: 'tui_clipboard_unavailable' | 'tui_clipboard_failed' };

export function clipboardPayload(text: string, platform: NodeJS.Platform = process.platform): Buffer {
  return platform === 'win32' ? Buffer.from(text, 'utf16le') : Buffer.from(text, 'utf8');
}

export async function copyToClipboard(text: string, platform: NodeJS.Platform = process.platform): Promise<ClipboardResult> {
  const backend = BACKENDS[platform];
  if (backend === undefined) return { code: 'tui_clipboard_unavailable' };
  const payload = clipboardPayload(text, platform);
  const exited = await new Promise<number | null>((resolve) => {
    const child = spawn(backend.program, [...backend.args], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code));
    child.stdin.end(payload);
  });
  return exited === 0 ? { program: backend.program } : { code: 'tui_clipboard_failed' };
}

// 复制的是最近那一条回答：记录里最后一条有正文的 assistant 事件，流式期间那半截不算（那条还没落盘）。
export function lastAnswer(events: readonly { kind: string; text?: string }[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'assistant' && typeof event.text === 'string' && event.text !== '') return event.text;
  }
  return '';
}
