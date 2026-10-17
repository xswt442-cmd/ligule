// Kernel 及其组件统一使用带稳定错误码的错误类型，供调用方分支处理。
// 第二个参数沿用 `Error` options，可通过 `cause` 保留底层错误。
export interface KernelErrorOptions extends ErrorOptions {
  readonly detail?: string;
}

export class KernelError extends Error {
  readonly code: string;
  readonly detail: string | undefined;

  constructor(code: string, options?: KernelErrorOptions) {
    super(code, options);
    this.name = 'KernelError';
    this.code = code;
    // 错误说明会提供给模型；稳定错误码供调用方判断。
    this.detail = options?.detail;
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
