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
      const categories: readonly ProviderDiagnosticCategory[] = ['authentication', 'rate_limit', 'client', 'server', 'http', 'transport', 'stream', 'invalid_response', 'cancelled'];
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
