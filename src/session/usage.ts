// 未配置上下文窗口也保存端点实际报回的用量；窗口只控制压缩策略。
export interface ModelRequest {
  readonly system?: string;
  readonly tools?: unknown;
  readonly messages: unknown[];
}

// ponytail: 字节数除以四只提供粗估；端点用量校准整个请求，语言偏差仍需真实使用数据核对。
export function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value ?? ''), 'utf8') / 4);
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
