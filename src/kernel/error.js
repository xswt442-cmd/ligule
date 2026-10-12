// 内核与它装配的组件共用一个错误形状：每次失败带一个稳定的错误码，调用方按码分支（I9）。
// 第二个参数原样交给 Error，所以底层原因可以用 cause 带出去。
export class KernelError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = 'KernelError';
    this.code = code;
    // 给模型看的那一份说明。码用于调用方分支，说明用于让模型改下一次调用（D19）。
    this.detail = options?.detail;
  }
}

// 内核自身的故障，与工具没做成那一类分开：前者说明这一次运行的记录或状态已经不可信，
// 循环要停住；后者记成一条失败事件，循环带着它继续问模型。
export class KernelRuntimeError extends KernelError {
  constructor(code, options) {
    super(code, options);
    this.name = 'KernelRuntimeError';
  }
}
