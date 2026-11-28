import { randomUUID } from 'node:crypto';
import { KernelError } from '../kernel/error.js';
import { currentKernelExecutionContext } from '../kernel/execution-context.js';
import type { LoggerBackend } from '../kernel/log.js';
import type { PolicyAskResult, PolicyQuestion } from '../kernel/policy.js';
import { currentTelemetryContext, emitTelemetry, telemetryEnabled, type Telemetry } from '../kernel/telemetry.js';
import { errorCode, isRecord } from '../shared/guards.js';
import type { AskQuestion } from '../tools/ask-user.js';
import { approvalArgsDigest, summarizeApproval } from './approval.js';
import { APPROVAL_METHOD, QUESTION_METHOD } from './protocol.js';
import type { HostClientConnection, HostSessionBase, PendingRunAsk } from './types.js';

export type PolicyRememberScope = 'session' | 'project' | 'user';
type RememberTarget = 'file' | 'workspace' | 'tool' | 'command';
export type PendingApprovalDetails = Map<string, { sessionId: string; args: Record<string, unknown>; argumentSha256: string }>;
type AskState = Pick<HostSessionBase, 'asks' | 'asksByRun' | 'runInputRevisions'>;

function trackAsk(state: AskState, pending: PendingRunAsk, runId?: string): void {
  state.asks.add(pending);
  if (runId === undefined) return;
  const asks = state.asksByRun.get(runId) ?? new Set<PendingRunAsk>();
  asks.add(pending);
  state.asksByRun.set(runId, asks);
}

function untrackAsk(state: AskState, pending: PendingRunAsk, runId?: string): void {
  state.asks.delete(pending);
  if (runId === undefined) return;
  const asks = state.asksByRun.get(runId);
  asks?.delete(pending);
  if (asks?.size === 0) state.asksByRun.delete(runId);
}

export function settleRunAsks(state: AskState, runId: string): string[] {
  const pending = [...(state.asksByRun.get(runId) ?? [])];
  for (const ask of pending) ask.settle();
  return pending.map(ask => ask.requestId);
}

function revisionOf(state: AskState, runId: string | undefined): number {
  return runId === undefined ? 0 : state.runInputRevisions?.get(runId) ?? 0;
}

export function advanceRunInputRevision(state: AskState, runId: string): void {
  const revisions = state.runInputRevisions ??= new Map();
  revisions.set(runId, revisionOf(state, runId) + 1);
}

interface SessionInteractionContext {
  readonly state: AskState & Pick<HostSessionBase, 'id' | 'activeRunId' | 'operationSourceSessionId' | 'progressId' | 'subagents' | 'taskBudget'>;
  readonly projectRoot: string;
  readonly connection: Pick<HostClientConnection, 'request'>;
  readonly permissionControl: boolean;
  readonly canPersistRules: boolean;
  readonly pendingApprovalDetails: PendingApprovalDetails;
  readonly telemetry: Telemetry;
  readonly logger?: Pick<LoggerBackend, 'log'>;
  recordActivity(kind: 'awaiting_approval' | 'awaiting_user', tool: string, requestId: string, callId?: string): Promise<void>;
  setWaiting(waiting: boolean, kind: 'approval' | 'input'): void;
  rememberRule(tool: string, input: unknown, command: string | undefined, scope: PolicyRememberScope,
    target: RememberTarget | undefined, identityDigest: string | undefined): Promise<void>;
}

export function createSessionInteractions({
  state, projectRoot, connection, permissionControl, canPersistRules, pendingApprovalDetails,
  telemetry, logger, recordActivity, setWaiting, rememberRule,
}: SessionInteractionContext) {
  const id = state.id;
  async function askApproval({
    tool, input, command, reason, shell, executable, policy, policySource, policyForced, rememberable, scriptBinding, callId, identityDigest,
  }: PolicyQuestion): Promise<PolicyAskResult> {
    const telemetryContext = telemetryEnabled(telemetry) ? currentTelemetryContext() : undefined;
    const telemetryApprovalRunId = telemetryContext?.runId
      ?? (telemetryContext?.sessionId === undefined || telemetryContext.sessionId === id ? state.activeRunId : undefined);
    const rememberScopes: PolicyRememberScope[] = permissionControl && rememberable
      ? ['session', ...(canPersistRules ? ['project' as const, 'user' as const] : [])] : [];
    const requestId = randomUUID();
    const childRunId = currentKernelExecutionContext()?.runId;
    const interactionRunId = childRunId ?? state.activeRunId;
    const requestSteeringRevision = revisionOf(state, interactionRunId);
    let summary;
    try {
      summary = summarizeApproval({
        requestId, sessionId: id, runId: state.progressId, callId, identityDigest, tool, args: input, command, reason,
        policy, policySource, policyForced, ...(shell === undefined ? {} : { shell, executable }),
      });
    } catch (error) {
      const failure = error instanceof KernelError ? error : new KernelError('policy_approval_unreviewable', { cause: error });
      return { decision: 'unavailable', code: failure.code, reason: 'This operation could not be reviewed safely.' };
    }
    const approvalArgs = structuredClone(input) as Record<string, unknown>;
    pendingApprovalDetails.set(requestId, { sessionId: id, args: approvalArgs, argumentSha256: summary.argumentSha256 });
    let approvalActive = true;
    let settle = (): void => {};
    const cancelled = new Promise<{ decision: 'cancelled'; code: string }>((resolve) => {
      settle = () => { approvalActive = false; resolve({ decision: 'cancelled', code: 'policy_approval_cancelled' }); };
    });
    const pendingAsk = { requestId, settle };
    trackAsk(state, pendingAsk, interactionRunId);
    if (childRunId !== undefined) state.subagents?.interaction(childRunId, 'approval', true);
    const endInteraction = state.taskBudget?.startInteraction();
    setWaiting(true, 'approval');
    const approvalStartedAt = telemetryContext === undefined ? 0n : process.hrtime.bigint();
    const telemetryFields = telemetryContext?.executionId === undefined ? undefined : {
      executionId: telemetryContext.executionId, sessionId: telemetryContext.sessionId ?? id, requestId,
      ...(telemetryApprovalRunId === undefined ? {} : { runId: telemetryApprovalRunId }),
      ...(telemetryContext.userSeq === undefined ? {} : { userSeq: telemetryContext.userSeq }),
      ...(telemetryContext.parentExecutionId === undefined ? {} : { parentExecutionId: telemetryContext.parentExecutionId }),
      ...(telemetryContext.parentRunId === undefined ? {} : { parentRunId: telemetryContext.parentRunId }),
      ...(telemetryContext.parentCallId === undefined ? {} : { parentCallId: telemetryContext.parentCallId }),
      ...(callId === undefined ? {} : { callId }),
    };
    if (telemetryFields !== undefined) emitTelemetry(telemetry, { type: 'approval.started', ...telemetryFields });
    try {
      await recordActivity('awaiting_approval', tool, requestId, callId);
      const answer = await Promise.race([
        connection.request(APPROVAL_METHOD, {
          ...summary, projectRoot, rememberable: rememberScopes.length > 0, rememberScopes,
          ...(state.operationSourceSessionId === undefined ? {} : { sourceSessionId: state.operationSourceSessionId }),
          ...(scriptBinding === undefined ? {} : { scriptBinding }),
        }).then(async (value): Promise<PolicyAskResult> => {
          if (!approvalActive || requestSteeringRevision !== revisionOf(state, interactionRunId)) {
            return { decision: 'cancelled', code: 'policy_approval_cancelled' };
          }
          const response = isRecord(value) ? value : value === true ? { decision: 'allow' } : value === false ? { decision: 'deny' } : {};
          const source = response.source === 'controller' ? 'controller' : 'human';
          if (response.decision === 'allow') {
            if (approvalArgsDigest(input) !== summary.argumentSha256) {
              return { decision: 'error', code: 'policy_approval_arguments_changed' };
            }
            const { rememberScope, rememberTarget } = response;
            if (rememberScope === undefined) return { decision: 'allow', source };
            if (source !== 'human') return { decision: 'error', code: 'policy_memory_trusted_user_required' };
            if (rememberScope !== 'session' && rememberScope !== 'project' && rememberScope !== 'user') {
              return { decision: 'error', code: 'policy_memory_unavailable' };
            }
            if (!rememberScopes.includes(rememberScope)) return { decision: 'error', code: 'policy_memory_unavailable' };
            if (rememberTarget !== undefined && rememberTarget !== 'file' && rememberTarget !== 'workspace'
              && rememberTarget !== 'tool' && rememberTarget !== 'command') {
              return { decision: 'error', code: 'policy_memory_target_invalid' };
            }
            try {
              await rememberRule(tool, input, command, rememberScope, rememberTarget, identityDigest);
            } catch (error) {
              const failure = error instanceof KernelError ? error : new KernelError('policy_memory_write_failed', { cause: error });
              logger?.log?.('approval memory was not saved', { tool, code: failure.code });
              return { decision: 'error', code: failure.code, reason: failure.detail ?? 'the remembered rule was not saved' };
            }
            return { decision: 'allow', source };
          }
          if (response.decision === 'deny') {
            return {
              decision: 'deny', source, code: source === 'human' ? 'ask_declined' : 'controller_declined',
              reason: source === 'human' ? 'the user declined' : 'the controller declined',
            };
          }
          if (response.decision === 'unavailable' || response.decision === 'error'
            || response.decision === 'cancelled' || response.decision === 'timeout') {
            return {
              decision: response.decision,
              code: typeof response.code === 'string' ? response.code : 'policy_approval_channel_error',
              ...(typeof response.reason === 'string' ? { reason: response.reason } : {}),
            };
          }
          return { decision: 'error', code: 'policy_approval_response_invalid' };
        }, (error): PolicyAskResult => {
          const code = errorCode(error) ?? 'policy_approval_channel_error';
          logger?.log?.(`approval failed for ${tool}`, { tool, code });
          return { decision: 'error', code, reason: 'approval channel failed' };
        }),
        cancelled,
      ]);
      if (telemetryFields !== undefined) emitTelemetry(telemetry, {
        type: 'approval.finished', ...telemetryFields,
        durationMs: Number((process.hrtime.bigint() - approvalStartedAt) / 1_000_000n),
        decision: answer.decision === 'allow' ? 'allow' : answer.decision === 'deny' ? 'deny'
          : answer.decision === 'cancelled' ? 'cancelled' : 'error',
        ...(answer.decision === 'error' || answer.decision === 'cancelled' ? { errorCode: answer.code } : {}),
      });
      return answer;
    } finally {
      approvalActive = false;
      endInteraction?.();
      pendingApprovalDetails.delete(requestId);
      untrackAsk(state, pendingAsk, interactionRunId);
      if (childRunId !== undefined) state.subagents?.interaction(childRunId, 'approval', false);
      setWaiting(false, 'approval');
    }
  }

  async function askQuestion(questions: readonly AskQuestion[]): Promise<unknown> {
    const childRunId = currentKernelExecutionContext()?.runId;
    const interactionRunId = childRunId ?? state.activeRunId;
    const questionSteeringRevision = revisionOf(state, interactionRunId);
    const requestId = randomUUID();
    let settle = (): void => {};
    const cancelled = new Promise<'cancelled'>((resolve) => { settle = () => resolve('cancelled'); });
    const pendingAsk = { requestId, settle };
    trackAsk(state, pendingAsk, interactionRunId);
    if (childRunId !== undefined) state.subagents?.interaction(childRunId, 'question', true);
    const endInteraction = state.taskBudget?.startInteraction();
    setWaiting(true, 'input');
    try {
      await recordActivity('awaiting_user', 'ask_user', requestId);
      const outcome = await Promise.race([
        connection.request(QUESTION_METHOD, { requestId, sessionId: id, projectRoot, questions }).then((value) => {
          if (questionSteeringRevision !== revisionOf(state, interactionRunId)) {
            throw new KernelError('ask_user_cancelled', { detail: `${id}: the question was superseded by steering input` });
          }
          return value;
        }),
        cancelled,
      ]);
      if (outcome === 'cancelled') {
        throw new KernelError('ask_user_cancelled', { detail: `${id}: the round was cancelled while the question waited for an answer` });
      }
      return outcome;
    } catch (error) {
      if (error instanceof KernelError) throw error;
      const reason = isRecord(error) && typeof error.message === 'string' ? error.message : String(error);
      logger?.log?.('ask user request failed', { sessionId: id, code: errorCode(error), reason });
      throw new KernelError('ask_user_host_gone', { detail: `${id}: ${reason}` });
    } finally {
      endInteraction?.();
      untrackAsk(state, pendingAsk, interactionRunId);
      if (childRunId !== undefined) state.subagents?.interaction(childRunId, 'question', false);
      setWaiting(false, 'input');
    }
  }

  return { askApproval, askQuestion };
}
