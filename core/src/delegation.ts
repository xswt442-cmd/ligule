import { createHash } from 'node:crypto';
import type { ProviderDiagnostic } from './kernel/error.js';
import { KernelError } from './kernel/error.js';
import type { LoopResult } from './kernel/loop.js';
import { assertSupportedSchema, validateArgs } from './kernel/schema.js';

export const MAX_DELEGATION_SCHEMA_BYTES = 32 * 1024;
export const MAX_DELEGATION_RESULT_BYTES = 64 * 1024;

export interface OutputSchemaContract {
  readonly schema: Record<string, unknown>;
  readonly wrapped: Record<string, unknown>;
  readonly digest: string;
}

export function createOutputSchemaContract(value: unknown): OutputSchemaContract {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KernelError('delegation_schema_invalid');
  }
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); }
  catch (cause) { throw new KernelError('delegation_schema_invalid', { cause }); }
  if (encoded === undefined) throw new KernelError('delegation_schema_invalid');
  if (Buffer.byteLength(encoded, 'utf8') > MAX_DELEGATION_SCHEMA_BYTES) {
    throw new KernelError('delegation_schema_too_large');
  }
  const schema = value as Record<string, unknown>;
  const wrapped = { type: 'object', properties: { result: schema }, required: ['result'] };
  try { assertSupportedSchema(wrapped); }
  catch (cause) { throw new KernelError('delegation_schema_invalid', { cause }); }
  return { schema, wrapped, digest: createHash('sha256').update(encoded).digest('hex').slice(0, 16) };
}

export function validateStructuredOutput(
  contract: OutputSchemaContract,
  value: unknown,
): { readonly encoded: string; readonly errors: readonly string[] } {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); }
  catch (cause) { throw new KernelError('delegation_result_invalid', { cause }); }
  if (encoded === undefined) throw new KernelError('delegation_result_invalid');
  if (Buffer.byteLength(encoded, 'utf8') > MAX_DELEGATION_RESULT_BYTES) {
    throw new KernelError('delegation_result_too_large');
  }
  return { encoded, errors: validateArgs(contract.wrapped, { result: value }) };
}

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

export interface RunValidation {
  readonly status: 'not_requested' | 'valid' | 'invalid';
  readonly schemaDigest?: string;
  readonly errors?: readonly string[];
}

export interface RunResult {
  readonly runId: string;
  readonly sessionId: string;
  readonly state: RunState;
  readonly stopReason: RunStopReason;
  readonly output: { readonly text: string | null; readonly structured?: unknown };
  readonly validation: RunValidation;
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

export function completedRunResult(
  runId: string,
  sessionId: string,
  result: LoopResult,
  options: { readonly structured?: unknown; readonly validation?: RunValidation } = {},
): RunResult {
  return {
    runId,
    sessionId,
    state: 'completed',
    stopReason: result.completedBy === undefined ? 'assistant_completed' : 'tool_completed',
    output: {
      text: result.text,
      ...(Object.hasOwn(options, 'structured') ? { structured: options.structured } : {}),
    },
    validation: options.validation ?? { status: 'not_requested' },
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
