// 未配置上下文窗口也保存端点实际报回的用量；窗口只控制压缩策略。
import { isImageReference } from './media.js';
export interface ModelRequest {
  readonly system?: string;
  readonly tools?: unknown;
  readonly messages: unknown[];
}

// 按字节数除以四得到粗略 Token 估算；具体偏差由服务端用量持续校准。
export function estimateTokens(value: unknown): number {
  function imageCount(item: unknown): number {
    if (isImageReference(item)) return 1;
    if (Array.isArray(item)) return item.reduce((sum, child) => sum + imageCount(child), 0);
    if (typeof item === 'object' && item !== null) return Object.values(item).reduce<number>((sum, child) => sum + imageCount(child), 0);
    return 0;
  }
  return Math.ceil(Buffer.byteLength(JSON.stringify(value ?? ''), 'utf8') / 4) + imageCount(value) * 4096;
}

export function estimateRequest(request: ModelRequest): number {
  return estimateTokens({ system: request.system ?? '', tools: request.tools ?? [], messages: request.messages });
}

export function usageEvent(request: ModelRequest, events: unknown[]): {
  kind: 'usage'; ignorable: true; input: number; output: number | null; estimated: number; measurement: 'request-v1';
} | null {
  const usage = (events as { type?: string; input?: unknown; output?: unknown }[]).find((event) => event?.type === 'usage');
  const input = Number(usage?.input);
  if (!Number.isFinite(input) || input <= 0) return null;
  return {
    kind: 'usage',
    ignorable: true,
    input,
    output: Number.isFinite(Number(usage?.output)) ? Number(usage?.output) : null,
    estimated: estimateRequest(request),
    measurement: 'request-v1',
  };
}
