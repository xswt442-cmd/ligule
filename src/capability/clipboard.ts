// 本机剪贴板程序的调用边界：平台编码、进程启动与管道错误都在能力层处理。
import { spawn } from 'node:child_process';

const BACKENDS: Partial<Record<NodeJS.Platform, { readonly program: string; readonly args: readonly string[] }>> = {
  win32: { program: 'clip', args: [] },
  darwin: { program: 'pbcopy', args: [] },
};

export type ClipboardResult =
  | { readonly program: string }
  | { readonly code: 'tui_clipboard_unavailable' | 'tui_clipboard_failed'; readonly detail?: string };

export function clipboardPayload(text: string, platform: NodeJS.Platform = process.platform): Buffer {
  return platform === 'win32' ? Buffer.from(text, 'utf16le') : Buffer.from(text, 'utf8');
}

export async function writeClipboard(program: string, args: readonly string[], payload: Buffer): Promise<ClipboardResult> {
  return new Promise((resolve) => {
    let settled = false;
    let inputError: Error | undefined;
    const finish = (result: ClipboardResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(program, [...args], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.on('error', (error) => { inputError = error; });
    child.once('error', (error) => {
      finish((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { code: 'tui_clipboard_unavailable', detail: error.message }
        : { code: 'tui_clipboard_failed', detail: error.message });
    });
    child.once('close', (code, signal) => {
      if (inputError !== undefined) {
        finish({ code: 'tui_clipboard_failed', detail: inputError.message });
      } else if (code === 0) {
        finish({ program });
      } else {
        finish({ code: 'tui_clipboard_failed', detail: signal ?? `exit code ${code}` });
      }
    });
    child.stdin.end(payload);
  });
}

export async function copyToClipboard(text: string, platform: NodeJS.Platform = process.platform): Promise<ClipboardResult> {
  const backend = BACKENDS[platform];
  if (backend === undefined) return { code: 'tui_clipboard_unavailable' };
  return writeClipboard(backend.program, backend.args, clipboardPayload(text, platform));
}
