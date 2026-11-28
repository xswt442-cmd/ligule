import { KernelError } from '../kernel/error.js';
import type { ModelRequest, ProviderEvent } from '../kernel/loop.js';
import { isRecord } from '../shared/guards.js';
import type { ProviderCapabilities } from './http.js';

export type JsonRecord = Record<string, unknown>;

export interface ModelProvider<Capabilities extends ProviderCapabilities = ProviderCapabilities> {
  readonly imageInput: boolean;
  readonly requiresCompletion: true;
  readonly name: string;
  readonly model: string;
  readonly capabilities: Capabilities;
  readonly outputTokens: number;
  stream(request: ModelRequest, options?: { readonly signal?: AbortSignal | null }): AsyncGenerator<ProviderEvent>;
  withModel(model: string): ModelProvider<Capabilities>;
}

export function asRecord(value: unknown, detail: string): JsonRecord {
  if (!isRecord(value)) {
    throw new KernelError('provider_stream_invalid', { detail });
  }
  return value;
}

export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function booleanCapability(value: boolean | number, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new KernelError('provider_capability_invalid', { detail: `${name} must be a boolean` });
  }
  return value;
}

export function numberCapability(value: boolean | number, name: string): number {
  if (typeof value !== 'number') {
    throw new KernelError('provider_capability_invalid', { detail: `${name} must be a number` });
  }
  return value;
}

// 参数无法解析时立即报错。空参数片段表示无参数调用，不等同于参数缺失。
export function parseArgs(json: string): unknown {
  if (json === '') return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed;
  } catch {
    throw new KernelError('provider_tool_args_invalid', { detail: 'tool arguments are not valid JSON' });
  }
}
