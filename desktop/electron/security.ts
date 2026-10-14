import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { DesktopNotification } from './api.js';

export const APP_PAGE = 'app://ligule/index.html';
export const DEV_PAGE = 'http://localhost:5188/';
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const PRODUCTION_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export const DEVELOPMENT_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self' ws://localhost:5188; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function developmentCsp(nonce: unknown): string {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(nonce)) throw new Error('desktop_development_nonce_invalid');
  return DEVELOPMENT_CSP.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`);
}

export function approvedPage(value: string, expected: string): boolean {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href === expected && url.username === '' && url.password === '';
  } catch { return false; }
}

export function assertSender(event: IpcMainInvokeEvent, window: BrowserWindow, page: string): void {
  if (window.isDestroyed() || event.sender !== window.webContents || event.sender.isDestroyed()
    || event.senderFrame === null || event.senderFrame !== window.webContents.mainFrame
    || !approvedPage(event.senderFrame.url, page)) throw new Error('desktop_sender_rejected');
}

export function validateFrame(value: unknown): string {
  const text = requiredText(value, MAX_FRAME_BYTES, 'desktop_frame_invalid', false);
  if (text.includes('\n') || text.includes('\r')) throw new Error('desktop_frame_invalid');
  let frame: unknown;
  try { frame = JSON.parse(text); } catch { throw new Error('desktop_frame_invalid'); }
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('desktop_frame_invalid');
  return text;
}

export function requiredText(value: unknown, limit: number, error: string, controls = true): string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value) > limit
    || (controls && /[\u0000-\u001f\u007f]/u.test(value))) throw new Error(error);
  return value;
}

export function validateDefaultName(value: unknown): string {
  const name = requiredText(value, 128, 'desktop_export_name_invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/u.test(name) || name.includes('..')) throw new Error('desktop_export_name_invalid');
  return name;
}

export function validateNotification(value: unknown): DesktopNotification {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('desktop_notification_invalid');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 4 || Object.keys(item).some(key => !['title', 'body', 'target', 'openLabel'].includes(key))) throw new Error('desktop_notification_invalid');
  const title = requiredText(item.title, 256, 'desktop_notification_invalid');
  const body = requiredText(item.body, 1024, 'desktop_notification_invalid');
  const openLabel = requiredText(item.openLabel, 64, 'desktop_notification_invalid');
  if (title !== 'ligule' || !['打开会话', 'Open conversation'].includes(openLabel)) throw new Error('desktop_notification_invalid');
  const labels = ['需要你的回答', '有操作等待审批', '本轮已完成', '本轮运行失败', '连接已中断', 'Your answer is needed', 'An action needs approval', 'Turn completed', 'Turn failed', 'Connection interrupted'];
  if (!labels.some(label => body === label || (body.endsWith(` · ${label}`) && body.length - label.length <= 123))) throw new Error('desktop_notification_invalid');
  if (typeof item.target !== 'string' || Buffer.byteLength(item.target) > 16 * 1024) throw new Error('desktop_notification_invalid');
  if (item.target !== '') {
    let target: unknown;
    try { target = JSON.parse(item.target); } catch { throw new Error('desktop_notification_invalid'); }
    if (target === null || typeof target !== 'object' || Array.isArray(target)) throw new Error('desktop_notification_invalid');
    const fields = target as Record<string, unknown>;
    if (Object.keys(fields).length !== 2 || typeof fields.sessionId !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(fields.sessionId)
      || typeof fields.projectRoot !== 'string' || (fields.projectRoot !== '' && !isAbsolute(fields.projectRoot))
      || /[\u0000-\u001f\u007f]/u.test(fields.projectRoot)) throw new Error('desktop_notification_invalid');
  }
  return { title, body, target: item.target, openLabel };
}

export function resourcePath(root: string, address: string): string {
  const url = new URL(address);
  if (url.protocol !== 'app:' || url.hostname !== 'ligule' || url.port !== '' || url.username !== '' || url.password !== '' || url.search !== '') throw new Error('desktop_resource_rejected');
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.includes('\\') || pathname.includes('\0')) throw new Error('desktop_resource_rejected');
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  const inside = relative(root, file);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('desktop_resource_rejected');
  return file;
}
