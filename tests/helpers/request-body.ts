// 测试内的 stub HTTP 服务读取请求体：Host 可能在请求途中被停止或杀掉，
// 这时服务端会收到空或不完整的 JSON。把解析失败当成“请求不完整”返回，
// 不要让它变成测试结束后的 unhandledRejection（会直接让测试进程以 1 退出）。
import type { IncomingMessage } from 'node:http';

export async function readJsonBody<T>(request: IncomingMessage): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  } catch {
    return undefined;
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    return undefined;
  }
}
