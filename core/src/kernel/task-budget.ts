import { KernelError } from './error.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TaskBudgetLimits {
  readonly maxModelCalls: number;
  readonly timeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly interactionWaitTimeoutMs?: number;
}

export interface TaskWork {
  suspend(): void;
  resume(): void;
  dispose(): void;
}

export interface TaskBudget {
  readonly signal: AbortSignal;
  consumeModelCall(): void;
  startWork(): TaskWork;
  runWork<T>(fn: () => Promise<T>): Promise<T>;
  suspendCurrentWork(): () => void;
  startInteraction(): () => void;
  request(signal?: AbortSignal): { readonly signal: AbortSignal; dispose(): void };
  snapshot(): {
    readonly modelCalls: number;
    readonly maxModelCalls: number;
    readonly timeoutMs: number;
    readonly requestTimeoutMs: number;
    readonly interactionWaitTimeoutMs: number;
    readonly interactionWaitMs: number;
    readonly executionElapsedMs: number;
    readonly executionPaused: boolean;
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
  const interactionLimit = limits.interactionWaitTimeoutMs ?? 43_200_000;
  positiveInteger(interactionLimit, 'interactionWaitTimeoutMs', 604_800_000);
  if (limits.requestTimeoutMs > limits.timeoutMs) throw new TypeError('requestTimeoutMs must not exceed timeoutMs');

  const started = Date.now();
  const controller = new AbortController();
  let modelCalls = 0;
  let disposed = false;
  const activeRequests = new Set<() => void>();
  const deadlineError = new KernelError('task_deadline_exceeded');
  const interactionError = new KernelError('task_interaction_timeout');
  const context = new AsyncLocalStorage<TaskWork>();
  let active = 0;
  let interactions = 0;
  let executionElapsed = 0;
  let interactionElapsed = 0;
  let lastTick = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  function tick(): void {
    const now = performance.now();
    const elapsed = Math.max(0, now - lastTick);
    lastTick = now;
    if (interactions > 0) interactionElapsed += elapsed;
    if (interactions === 0 || active > 0) executionElapsed += elapsed;
  }
  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer);
    if (disposed || controller.signal.aborted) return;
    if (interactionElapsed >= interactionLimit) { controller.abort(interactionError); return; }
    if (executionElapsed >= limits.timeoutMs) { controller.abort(deadlineError); return; }
    const executionRemaining = interactions > 0 && active === 0 ? Infinity : limits.timeoutMs - executionElapsed;
    const interactionRemaining = interactions > 0 ? interactionLimit - interactionElapsed : Infinity;
    const remaining = Math.min(executionRemaining, interactionRemaining);
    if (Number.isFinite(remaining)) {
      timer = setTimeout(() => { tick(); schedule(); }, Math.max(1, Math.ceil(remaining)));
      timer.unref?.();
    }
  }
  function change(fn: () => void): void { tick(); schedule(); fn(); schedule(); }
  const onParentAbort = () => controller.abort(parentSignal?.reason ?? new KernelError('task_cancelled'));
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  schedule();

  function check(): void {
    if (disposed) throw new KernelError('task_budget_disposed');
    tick();
    schedule();
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof KernelError) throw reason;
      throw new KernelError('task_cancelled', { cause: reason });
    }
  }

  return {
    signal: controller.signal,
    startWork() {
      let working = true;
      let ended = false;
      change(() => { active += 1; });
      return {
        suspend() { if (!ended && working) change(() => { working = false; active -= 1; }); },
        resume() { if (!ended && !working) change(() => { working = true; active += 1; }); },
        dispose() { if (!ended) change(() => { ended = true; if (working) active -= 1; }); },
      };
    },
    async runWork(fn) {
      const work = this.startWork();
      try { return await context.run(work, fn); }
      finally { work.dispose(); }
    },
    suspendCurrentWork() {
      const work = context.getStore();
      work?.suspend();
      let resumed = false;
      return () => { if (!resumed) { resumed = true; work?.resume(); } };
    },
    startInteraction() {
      const work = context.getStore();
      change(() => { interactions += 1; });
      work?.suspend();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        work?.resume();
        change(() => { interactions -= 1; });
      };
    },
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
      tick();
      schedule();
      return {
        modelCalls,
        maxModelCalls: limits.maxModelCalls,
        timeoutMs: limits.timeoutMs,
        requestTimeoutMs: limits.requestTimeoutMs,
        interactionWaitTimeoutMs: interactionLimit,
        interactionWaitMs: Math.floor(interactionElapsed),
        executionElapsedMs: Math.floor(executionElapsed),
        executionPaused: interactions > 0 && active === 0 && !controller.signal.aborted,
        startedAt: new Date(started).toISOString(),
        deadlineAt: new Date(Date.now() + Math.max(0, limits.timeoutMs - executionElapsed)).toISOString(),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
      for (const disposeRequest of activeRequests) disposeRequest();
    },
  };
}
