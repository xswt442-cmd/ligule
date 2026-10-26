import { KernelError } from './error.js';

export interface TaskBudgetLimits {
  readonly maxModelCalls: number;
  readonly timeoutMs: number;
  readonly requestTimeoutMs: number;
}

export interface TaskBudget {
  readonly signal: AbortSignal;
  consumeModelCall(): void;
  request(signal?: AbortSignal): { readonly signal: AbortSignal; dispose(): void };
  snapshot(): {
    readonly modelCalls: number;
    readonly maxModelCalls: number;
    readonly timeoutMs: number;
    readonly requestTimeoutMs: number;
    readonly startedAt: string;
    readonly deadlineAt: string;
  };
  dispose(): void;
}

function positiveInteger(value: number, name: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a positive integer no greater than ${maximum}`);
  }
}

export function createTaskBudget(limits: TaskBudgetLimits, parentSignal?: AbortSignal): TaskBudget {
  positiveInteger(limits.maxModelCalls, 'maxModelCalls', Number.MAX_SAFE_INTEGER);
  positiveInteger(limits.timeoutMs, 'timeoutMs', 86_400_000);
  positiveInteger(limits.requestTimeoutMs, 'requestTimeoutMs', 3_600_000);
  if (limits.requestTimeoutMs > limits.timeoutMs) throw new TypeError('requestTimeoutMs must not exceed timeoutMs');

  const started = Date.now();
  const deadline = started + limits.timeoutMs;
  const controller = new AbortController();
  let modelCalls = 0;
  let disposed = false;
  const activeRequests = new Set<() => void>();
  const deadlineError = new KernelError('task_deadline_exceeded');
  const onParentAbort = () => controller.abort(parentSignal?.reason ?? new KernelError('task_cancelled'));
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  const deadlineTimer = setTimeout(() => controller.abort(deadlineError), Math.max(0, deadline - Date.now()));
  deadlineTimer.unref?.();

  function check(): void {
    if (disposed) throw new KernelError('task_budget_disposed');
    if (Date.now() >= deadline) {
      controller.abort(deadlineError);
      throw deadlineError;
    }
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof KernelError) throw reason;
      throw new KernelError('task_cancelled', { cause: reason });
    }
  }

  return {
    signal: controller.signal,
    consumeModelCall() {
      check();
      if (modelCalls >= limits.maxModelCalls) {
        const error = new KernelError('task_model_budget_exhausted');
        controller.abort(error);
        throw error;
      }
      modelCalls += 1;
    },
    request(callerSignal) {
      check();
      const requestController = new AbortController();
      const forward = (signal: AbortSignal) => {
        if (!requestController.signal.aborted) requestController.abort(signal.reason);
      };
      const onTaskAbort = () => forward(controller.signal);
      const onCallerAbort = () => callerSignal && forward(callerSignal);
      controller.signal.addEventListener('abort', onTaskAbort, { once: true });
      callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
      const requestError = new KernelError('task_request_timeout');
      const timer = setTimeout(() => requestController.abort(requestError), limits.requestTimeoutMs);
      timer.unref?.();
      if (controller.signal.aborted) onTaskAbort();
      if (callerSignal?.aborted) onCallerAbort();
      let requestDisposed = false;
      function disposeRequest(): void {
        if (requestDisposed) return;
        requestDisposed = true;
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onTaskAbort);
        callerSignal?.removeEventListener('abort', onCallerAbort);
        activeRequests.delete(disposeRequest);
      }
      activeRequests.add(disposeRequest);
      return {
        signal: requestController.signal,
        dispose: disposeRequest,
      };
    },
    snapshot() {
      return {
        modelCalls,
        maxModelCalls: limits.maxModelCalls,
        timeoutMs: limits.timeoutMs,
        requestTimeoutMs: limits.requestTimeoutMs,
        startedAt: new Date(started).toISOString(),
        deadlineAt: new Date(deadline).toISOString(),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(deadlineTimer);
      parentSignal?.removeEventListener('abort', onParentAbort);
      for (const disposeRequest of activeRequests) disposeRequest();
    },
  };
}
