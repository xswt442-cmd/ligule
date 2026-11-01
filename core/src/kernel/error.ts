// Kernel 及其组件统一使用带稳定错误码的错误类型，供调用方分支处理。
// 第二个参数沿用 `Error` options，可通过 `cause` 保留底层错误。
export interface KernelErrorOptions extends ErrorOptions {
  readonly detail?: string;
  readonly diagnostics?: ProviderDiagnostic;
}

export type ProviderDiagnosticCategory = 'authentication' | 'rate_limit' | 'client' | 'server' | 'http' | 'transport' | 'stream' | 'invalid_response' | 'cancelled';

export interface ProviderDiagnostic {
  readonly category: ProviderDiagnosticCategory;
  readonly status?: number;
  readonly attempts: number;
  readonly responseReceived: boolean;
  readonly streamReceived: boolean;
  readonly recoverable: boolean;
}

// Desktop、TUI 和 Host 共用同一份分类文案，避免各自维护一张会漂移的表。
export const PROVIDER_DIAGNOSTIC_CATEGORIES: Readonly<Record<ProviderDiagnosticCategory, readonly [string, string]>> = {
  authentication: ['身份认证', 'authentication'],
  rate_limit: ['请求限流', 'rate limit'],
  client: ['客户端请求', 'client request'],
  server: ['服务端故障', 'server failure'],
  http: ['HTTP 响应', 'HTTP response'],
  transport: ['传输故障', 'transport failure'],
  stream: ['响应流中断', 'response stream interrupted'],
  invalid_response: ['响应格式无效', 'invalid response'],
  cancelled: ['请求已取消', 'request cancelled'],
};

// 界面收到的诊断来自 JSON，先按稳定结构校验，再交给上表生成文案。
export function parseProviderDiagnostic(value: unknown): ProviderDiagnostic | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ProviderDiagnostic>;
  if (typeof candidate.category !== 'string' || !Object.hasOwn(PROVIDER_DIAGNOSTIC_CATEGORIES, candidate.category)
    || !Number.isSafeInteger(candidate.attempts) || (candidate.attempts ?? 0) < 1
    || typeof candidate.responseReceived !== 'boolean'
    || typeof candidate.streamReceived !== 'boolean'
    || typeof candidate.recoverable !== 'boolean'
    || (candidate.status !== undefined
      && (!Number.isSafeInteger(candidate.status) || candidate.status < 100 || candidate.status > 599))) {
    return undefined;
  }
  return {
    category: candidate.category as ProviderDiagnosticCategory,
    ...(candidate.status === undefined ? {} : { status: candidate.status }),
    attempts: candidate.attempts as number,
    responseReceived: candidate.responseReceived,
    streamReceived: candidate.streamReceived,
    recoverable: candidate.recoverable,
  };
}

// 一行诊断摘要：状态码 · 分类 · 尝试次数 · 响应/响应流 · 是否可重试。
export function providerDiagnosticText(diagnostic: ProviderDiagnostic): { readonly zh: string; readonly en: string } {
  const category = PROVIDER_DIAGNOSTIC_CATEGORIES[diagnostic.category];
  const status: readonly [string, string] = diagnostic.status === undefined
    ? ['HTTP 状态未知', 'HTTP status unknown']
    : [`HTTP ${diagnostic.status}`, `HTTP ${diagnostic.status}`];
  const attempts: readonly [string, string] = [`尝试 ${diagnostic.attempts} 次`, `${diagnostic.attempts} attempts`];
  const response: readonly [string, string] = diagnostic.responseReceived ? ['收到响应', 'response received'] : ['未收到响应', 'no response'];
  const stream: readonly [string, string] = diagnostic.streamReceived ? ['收到响应流', 'stream data received'] : ['未收到响应流', 'no stream data'];
  const recovery: readonly [string, string] = diagnostic.recoverable ? ['可恢复', 'recoverable'] : ['不可安全重试', 'not safe to retry'];
  return {
    zh: [status[0], category[0], attempts[0], response[0], stream[0], recovery[0]].join(' · '),
    en: [status[1], category[1], attempts[1], response[1], stream[1], recovery[1]].join(' · '),
  };
}

export class KernelError extends Error {
  readonly code: string;
  readonly detail: string | undefined;
  readonly diagnostics: ProviderDiagnostic | undefined;

  constructor(code: string, options?: KernelErrorOptions) {
    super(code, options);
    this.name = 'KernelError';
    this.code = code;
    // 错误说明会提供给模型；稳定错误码供调用方判断。
    this.detail = options?.detail;
    const diagnostics = options?.diagnostics;
    if (diagnostics !== undefined) {
      const categories: readonly string[] = Object.keys(PROVIDER_DIAGNOSTIC_CATEGORIES);
      if (!categories.includes(diagnostics.category)
        || !Number.isSafeInteger(diagnostics.attempts) || diagnostics.attempts < 1
        || (diagnostics.status !== undefined
          && (!Number.isSafeInteger(diagnostics.status) || diagnostics.status < 100 || diagnostics.status > 599))
        || typeof diagnostics.responseReceived !== 'boolean'
        || typeof diagnostics.streamReceived !== 'boolean'
        || typeof diagnostics.recoverable !== 'boolean') {
        throw new TypeError('provider diagnostics are invalid');
      }
    }
    this.diagnostics = diagnostics === undefined ? undefined : Object.freeze({
      category: diagnostics.category,
      ...(diagnostics.status === undefined ? {} : { status: diagnostics.status }),
      attempts: diagnostics.attempts,
      responseReceived: diagnostics.responseReceived,
      streamReceived: diagnostics.streamReceived,
      recoverable: diagnostics.recoverable,
    });
  }
}

// Kernel 内部故障表示运行状态或记录可能不可信，应中止循环。
// 普通工具失败作为失败事件写入记录，循环可以继续运行。
export class KernelRuntimeError extends KernelError {
  constructor(code: string, options?: KernelErrorOptions) {
    super(code, options);
    this.name = 'KernelRuntimeError';
  }
}
