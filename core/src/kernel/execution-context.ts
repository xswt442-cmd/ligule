import { AsyncLocalStorage } from 'node:async_hooks';

export interface KernelExecutionScope {
  active: boolean;
}

export interface KernelExecutionContext {
  readonly signal: AbortSignal;
  readonly callId: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly source?: 'human' | 'controller';
  readonly executionId?: string;
  readonly userSeq?: number;
  readonly parentCallId?: string;
  readonly parentRunId?: string;
  readonly parentExecutionId?: string;
  readonly extensionHookPhase?: 'prepareRequest' | 'beforeTool' | 'afterTool' | 'completeRun';
  readonly scope: KernelExecutionScope;
}

const executionContext = new AsyncLocalStorage<KernelExecutionContext>();

export function currentKernelExecutionContext(): KernelExecutionContext | undefined {
  return executionContext.getStore();
}

export function withKernelExecutionContext<TResult>(context: KernelExecutionContext, action: () => TResult): TResult {
  return executionContext.run(context, action);
}

export function withoutKernelExecutionContext<TResult>(action: () => TResult): TResult {
  return executionContext.exit(action);
}
