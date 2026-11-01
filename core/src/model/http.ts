// 共享模型 HTTP 能力：地址校验、重试策略、SSE 解析和凭据读取。
// Messages 与 Chat Completions 适配器共用此模块。
import { setTimeout as sleep } from 'node:timers/promises';
import { KernelError } from '../kernel/error.js';
import type { ProviderDiagnostic, ProviderDiagnosticCategory } from '../kernel/error.js';
import { resolveCredential } from '../kernel/credentials.js';
import { trimTrailingSeparators } from '../kernel/workspace.js';
import type { ModelMessage, ToolCall } from '../kernel/loop.js';

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly retry429: boolean;
  readonly retry5xx: boolean;
  readonly retryTransport: boolean;
}

export interface ProviderCapabilities {
  readonly [name: string]: boolean | number;
}

// 只重试 HTTP 429、5xx 和传输错误；请求构造错误和响应解析错误不重试。
// 重试次数和退避时间使用默认值，也可由配置层调整。
export const DEFAULT_RETRY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 500,
  retry429: true,
  retry5xx: true,
  retryTransport: true,
});

export const SSE_DONE = Symbol('sse-done');

// 配置不能突破提供方声明的能力上限：布尔能力只能关闭，数值限制取更小值。
export function resolveCapabilities(
  declared: ProviderCapabilities,
  requested: Readonly<Record<string, unknown>> = {},
): ProviderCapabilities {
  const effective = { ...declared };
  for (const [key, value] of Object.entries(requested)) {
    if (!Object.hasOwn(declared, key)) throw new KernelError('provider_capability_unknown', { detail: key });
    const declaredValue = declared[key];
    if (typeof value !== typeof declaredValue) {
      throw new KernelError('provider_capability_invalid', { detail: `${key} must be a ${typeof declaredValue}` });
    }
    if (typeof declaredValue === 'boolean') {
      if (typeof value !== 'boolean') throw new KernelError('provider_capability_invalid', { detail: `${key} must be a boolean` });
      effective[key] = value && declaredValue;
    } else {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new KernelError('provider_capability_invalid', { detail: `${key} must be a positive safe integer` });
      }
      effective[key] = Math.min(value, declaredValue);
    }
  }
  return Object.freeze(effective);
}

// 服务地址必须是无凭据、查询和片段的 HTTP(S) 根地址，避免请求目标随运行环境变化。
// 此处只校验地址并去除尾部斜杠；是否需要 `/v1` 由各接口适配器决定。
// 先去掉外围空白（`new URL` 接受结尾换行/空格，留着会在拼接路径时混进地址）。
export function apiRoot(baseUrl: unknown): string {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') throw new KernelError('provider_base_url_required');
  const trimmed = baseUrl.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new KernelError('provider_base_url_invalid', { detail: 'a full HTTP(S) root is required' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new KernelError('provider_base_url_invalid', { detail: 'an HTTP(S) root without credentials, query, or fragment' });
  }
  return trimTrailingSeparators(trimmed);
}

// 发送请求时才解析凭据；运行中更新密钥不需要重建提供方，配置快照也不保存密钥值。
export async function readCredential(apiKeyEnv: string): Promise<string> {
  const apiKey = await resolveCredential(apiKeyEnv);
  if (apiKey === undefined) {
    throw new KernelError('provider_credential_missing', { detail: apiKeyEnv });
  }
  return apiKey;
}

function backoffMs(baseDelayMs: number, attempt: number): number {
  return baseDelayMs * 2 ** (attempt - 1) * (0.9 + Math.random() * 0.2);
}

interface ProviderResponseContext {
  readonly attempts: number;
  readonly status?: number;
  readonly responseReceived: boolean;
  readonly streamReceived: boolean;
}

const responseContexts = new WeakMap<Response, ProviderResponseContext>();
const streamContexts = new WeakMap<ReadableStream<Uint8Array>, ProviderResponseContext>();

function diagnostic(
  category: ProviderDiagnosticCategory,
  context: ProviderResponseContext | undefined,
  streamReceived = false,
  recoverable = false,
): ProviderDiagnostic {
  return {
    category,
    ...(context?.status === undefined ? {} : { status: context.status }),
    attempts: context?.attempts ?? 1,
    responseReceived: context?.responseReceived ?? context?.status !== undefined,
    streamReceived: streamReceived || context?.streamReceived === true,
    recoverable,
  };
}

function providerError(
  code: string,
  category: ProviderDiagnosticCategory,
  context: ProviderResponseContext | undefined,
  options: { readonly detail?: string; readonly cause?: unknown; readonly streamReceived?: boolean; readonly recoverable?: boolean } = {},
): KernelError {
  return new KernelError(code, {
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
    diagnostics: diagnostic(category, context, options.streamReceived, options.recoverable),
  });
}

function httpFailureCategory(status: number): ProviderDiagnosticCategory {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'http';
}

function abortFailure(
  error: unknown,
  signal: AbortSignal | null | undefined,
  context: ProviderResponseContext,
  streamReceived = false,
): KernelError {
  const errorName = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;
  const reason = signal?.reason;
  const reasonName = typeof reason === 'object' && reason !== null && 'name' in reason ? reason.name : undefined;
  if (errorName === 'TimeoutError' || reasonName === 'TimeoutError') {
    return providerError('provider_timeout', 'transport', context, { streamReceived, recoverable: false });
  }
  return providerError('provider_cancelled', 'cancelled', context, { streamReceived });
}

async function httpFailureDetail(
  response: Response,
  context: ProviderResponseContext,
  signal?: AbortSignal | null,
): Promise<{ readonly detail: string; readonly streamReceived: boolean }> {
  const status = `HTTP ${response.status}`;
  if (![400, 413].includes(response.status) || response.body === null) {
    await response.body?.cancel();
    return { detail: status, streamReceived: false };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let remaining = 8192;
  let streamReceived = false;
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      streamReceived = streamReceived || value.byteLength > 0;
      const bytes = value.subarray(0, remaining);
      text += decoder.decode(bytes, { stream: true });
      remaining -= bytes.length;
    }
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw abortFailure(error, signal, context, streamReceived);
    }
    return { detail: status, streamReceived };
  } finally {
    try { await reader.cancel(); } catch { /* Preserve the safe HTTP classification. */ }
    reader.releaseLock();
  }
  // 使用固定分类执行一次上下文超限恢复，不将网关原文或请求凭据写入诊断。
  return {
    detail: /\b(context_length_exceeded|maximum context length|context window|prompt is too long|input is too long)\b/iu.test(text)
      ? `${status} context_length_exceeded` : status,
    streamReceived,
  };
}

// 只在响应开始前重试；流式内容一旦开始发送，再重试会导致重复内容。
export async function open(url: string, init: RequestInit, retry: RetryPolicy): Promise<Response> {
  // 退避等待期间收到取消信号时，转换为统一的取消错误码。
  const wait = async (attempt: number, context?: ProviderResponseContext): Promise<void> => {
    try {
      await sleep(backoffMs(retry.baseDelayMs, attempt), undefined, { signal: init.signal ?? undefined });
    } catch (error) {
      const activeContext = context ?? { attempts: attempt, responseReceived: false, streamReceived: false };
      throw abortFailure(error, init.signal, activeContext);
    }
  };
  let responseReceived = false;
  let streamReceived = false;
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      const context: ProviderResponseContext = { attempts: attempt, responseReceived, streamReceived };
      if (init.signal?.aborted || isAbortError(error)) {
        throw abortFailure(error, init.signal, context);
      }
      if (!retry.retryTransport || attempt >= retry.maxAttempts) {
        throw providerError('provider_transport_failed', 'transport', context, {
          cause: error,
          recoverable: retry.retryTransport,
        });
      }
      await wait(attempt);
      continue;
    }
    responseReceived = true;
    const context: ProviderResponseContext = { attempts: attempt, status: response.status, responseReceived, streamReceived };
    responseContexts.set(response, context);
    if (response.body !== null) streamContexts.set(response.body, context);
    if (response.ok) {
      if (response.body === null) {
        throw providerError('provider_stream_missing', 'invalid_response', context);
      }
      return response;
    }
    const retryable = (response.status === 429 && retry.retry429) || (response.status >= 500 && retry.retry5xx);
    if (!retryable || attempt >= retry.maxAttempts) {
      const failure = await httpFailureDetail(response, context, init.signal);
      throw providerError('provider_http_error', httpFailureCategory(response.status), context, {
        detail: failure.detail,
        streamReceived: failure.streamReceived,
        recoverable: retryable,
      });
    }
    await response.body?.cancel();
    await wait(attempt, context);
  }
}

// SSE 帧以空行结束，多个 `data` 行合并处理；其他字段和注释行不包含事件数据。
// `[DONE]` 是 Chat Completions 的结束标记，不是 JSON，需跳过。
// 流式请求取消时将 Node 的 AbortError 转换为 `provider_cancelled`，供客户端统一处理。
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error
    && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export async function readJson(response: Response, signal?: AbortSignal | null): Promise<unknown> {
  const context = responseContexts.get(response);
  if (response.body === null) {
    throw providerError('provider_stream_missing', 'invalid_response', context);
  }
  const body = response.body;
  const bodyContext = streamContexts.get(body) ?? context ?? { attempts: 1, responseReceived: false, streamReceived: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let completed = false;
  let streamReceived = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (value !== undefined) {
        streamReceived = streamReceived || value.byteLength > 0;
        chunks.push(value);
      }
    }
    if (signal?.aborted) {
      throw abortFailure(signal.reason, signal, bodyContext, streamReceived);
    }
  } catch (error) {
    if (error instanceof KernelError) throw error;
    if (signal?.aborted || isAbortError(error)) {
      throw abortFailure(error, signal, bodyContext, streamReceived);
    }
    throw providerError('provider_stream_interrupted', 'stream', bodyContext, {
      detail: 'the response body could not be read completely', streamReceived, recoverable: false,
    });
  } finally {
    if (!completed) {
      try { await reader.cancel(); } catch { /* Keep the response read classification. */ }
    }
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw providerError('provider_stream_invalid', 'invalid_response', bodyContext, {
      detail: 'response body is not valid JSON', streamReceived,
    });
  }
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>, { includeDone = false, signal }: { readonly includeDone?: boolean; readonly signal?: AbortSignal | null } = {},
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  const context = streamContexts.get(body) ?? { attempts: 1, responseReceived: false, streamReceived: false };
  let streamReceived = false;
  const reader = body.getReader();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    let completed = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          completed = true;
          return;
        }
        if (value !== undefined) {
          streamReceived = streamReceived || value.byteLength > 0;
          yield value;
        }
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw abortFailure(error, signal, context, streamReceived);
      }
      throw providerError('provider_stream_interrupted', 'stream', context, {
        detail: 'the response body could not be read completely', streamReceived, recoverable: false,
      });
    } finally {
      if (!completed) {
        try {
          await reader.cancel();
        } catch {
          // 保留读取错误；清理取消状态不能覆盖原始失败。
        }
      }
      reader.releaseLock();
    }
  }
  for await (const chunk of chunks()) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (data === '') continue;
      if (data === '[DONE]') {
        if (includeDone) yield SSE_DONE;
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(data);
        yield parsed;
      } catch {
        throw providerError('provider_stream_invalid', 'invalid_response', context, {
          detail: `invalid SSE JSON (${data.length} characters)`, streamReceived,
        });
      }
    }
  }
// 流结束时若仍有未完成帧，返回解析错误，避免静默丢失不完整工具调用。
if (buffer.trim() !== '') {
    throw providerError('provider_stream_incomplete', 'invalid_response', context, {
      detail: 'the stream ended inside a frame', streamReceived,
    });
  }
}

// 每个 assistant 工具调用都必须有对应结果；缺少结果会使后续请求被服务端拒绝。
export function assertAllAnswered(view: readonly ModelMessage[]): void {
  const pending: ToolCall[] = [];
  for (const entry of view) {
    if (entry.role === 'assistant') pending.push(...(entry.toolCalls ?? []));
    else if (entry.role === 'tool') {
      const index = pending.findIndex((call) => call.id === entry.id);
      if (index >= 0) pending.splice(index, 1);
    }
  }
  const unanswered = pending[0];
  if (unanswered !== undefined) {
    throw new KernelError('provider_unanswered_call', { detail: `${unanswered.name} (${unanswered.id})` });
  }
}

// 将工具结果转换为服务端要求的文本；非字符串结果使用 JSON 序列化。
export function resultText(content: unknown): string | undefined {
  return typeof content === 'string' ? content : JSON.stringify(content);
}
