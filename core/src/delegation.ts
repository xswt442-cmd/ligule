import type { ProviderDiagnostic } from './kernel/error.js';
import type { LoopResult } from './kernel/loop.js';

export type RunState = 'completed' | 'failed' | 'cancelled';
export type RunStopReason =
  | 'assistant_completed'
  | 'tool_completed'
  | 'cancelled'
  | 'budget_exhausted'
  | 'refused'
  | 'provider_error'
  | 'tool_error'
  | 'host_error';

export interface RunResult {
  readonly runId: string;
  readonly sessionId: string;
  readonly state: RunState;
  readonly stopReason: RunStopReason;
  readonly output: { readonly text: string | null; readonly structured?: unknown };
  readonly validation: { readonly status: 'not_requested' | 'valid' | 'invalid'; readonly errors?: readonly string[] };
  readonly artifacts: readonly { readonly kind: 'session'; readonly sessionId: string }[];
  readonly usage: { readonly iterations: number | null; readonly modelCalls: number | null };
  readonly diagnostic?: { readonly code: string; readonly provider?: ProviderDiagnostic };
}

const CANCELLED_CODES = new Set(['ask_user_cancelled', 'exec_cancelled', 'loop_cancelled', 'provider_cancelled']);

function stopReasonForCode(code: string): RunStopReason {
  if (CANCELLED_CODES.has(code)) return 'cancelled';
  if (code.includes('budget_exhausted') || code.includes('iteration_limit')) return 'budget_exhausted';
  if (code.startsWith('permission_') || code.startsWith('policy_')) return 'refused';
  if (code.startsWith('provider_')) return 'provider_error';
  if (code.startsWith('tool_')) return 'tool_error';
  return 'host_error';
}

function artifacts(sessionId: string): RunResult['artifacts'] {
  return [{ kind: 'session', sessionId }];
}

export function completedRunResult(runId: string, sessionId: string, result: LoopResult): RunResult {
  return {
    runId,
    sessionId,
    state: 'completed',
    stopReason: result.completedBy === undefined ? 'assistant_completed' : 'tool_completed',
    output: { text: result.text },
    validation: { status: 'not_requested' },
    artifacts: artifacts(sessionId),
    usage: { iterations: result.iterations, modelCalls: result.modelCalls },
  };
}

export function failedRunResult(
  runId: string,
  sessionId: string,
  code: string,
  provider?: ProviderDiagnostic,
): RunResult {
  const stopReason = stopReasonForCode(code);
  return {
    runId,
    sessionId,
    state: stopReason === 'cancelled' ? 'cancelled' : 'failed',
    stopReason,
    output: { text: null },
    validation: { status: 'not_requested' },
    artifacts: artifacts(sessionId),
    usage: { iterations: null, modelCalls: null },
    diagnostic: { code, ...(provider === undefined ? {} : { provider }) },
  };
}
