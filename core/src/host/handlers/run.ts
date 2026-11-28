import { DELEGATION_RESULT_TOOL, type DelegationSpec } from '../../delegation.js';
import { KernelError } from '../../kernel/error.js';
import { rememberRunSummary } from '../../kernel/run-summary.js';
import type { SessionEvent } from '../../session/event-types.js';
import {
  createRunAcceptance, findRunReceipt, isRunAcceptance, readRunResult, runPayloadDigest,
  type DurableRunReceipt, type RunAcceptance, type RunProvenance,
} from '../../session/run.js';
import { createSessionLog } from '../../session/session.js';
import { workspaceIdentity } from '../../workspace-identity.js';
import { requiredString, type HostMethodParams } from '../protocol.js';
import { readRunRecord } from '../run-read.js';
import { runLivenessOf, runReceiptView } from '../run-records.js';
import type { HostSessionState } from '../types.js';

type RunRecordMethod = 'run.receipt' | 'run.receipts' | 'run.result';
type RunMethod = RunRecordMethod | 'run.wait' | 'run.cancel' | 'run.steer';
type RunSession = Pick<HostSessionState, 'environment' | 'session' | 'activeRunId' | 'running' | 'operation' | 'runSteering'>;
type RunDirectory = { readonly projectRoot: string; readonly directory: string };

interface RunHandlerContext<State extends RunSession> {
  open(id: string): State;
  opened(id: string): State | undefined;
  environmentFor(projectRoot: unknown): Promise<RunDirectory>;
  recordPathOf(id: string, environment: RunDirectory): string;
  requireRunReference(state: State, runId: string): Promise<{ events: SessionEvent[]; scope: string }>;
  stopRun(state: State): Promise<void>;
  acceptInput(state: State, runId: string): string[];
  readonly source: 'human' | 'controller';
  readonly scopes?: readonly string[];
}

type RunOrigin = 'human' | 'controller';
type SubmitMethod = 'run.start' | 'run.submit';
type PendingReceipt = {
  readonly scope: string;
  readonly key: string | undefined;
  readonly digest: string;
  readonly receipt: Promise<DurableRunReceipt>;
};

interface RunSubmissionContext<State extends RunSession> {
  open(sessionId: string): State;
  serialize<Result>(sessionId: string, action: () => Promise<Result>): Promise<Result>;
  validate(state: State, delegation: DelegationSpec | undefined): void;
}

interface SubmissionCaller<State extends RunSession> {
  readonly controllerScope: string;
  readonly canRecordHuman: boolean;
  authorize(state: State): void;
  provenance(origin: RunOrigin, scope: string): RunProvenance;
  execute(state: State, input: string, origin: RunOrigin, delegation: DelegationSpec | undefined,
    acceptance: RunAcceptance, onAccepted: (userSeq: number) => void): Promise<unknown>;
  waitForPersisted(runId: string, origin: RunOrigin): Promise<unknown>;
}

export function runOriginOf(value: unknown, defaultOrigin: RunOrigin, canRecordHuman: boolean): RunOrigin {
  if (value !== undefined && value !== 'human' && value !== 'controller') throw new KernelError('protocol_args_invalid');
  return canRecordHuman ? value ?? defaultOrigin : 'controller';
}

function deferredReceipt() {
  let resolve!: (value: DurableRunReceipt) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<DurableRunReceipt>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function replaySubmission(events: readonly SessionEvent[], sessionId: string, scope: string, key: string | undefined, digest: string) {
  if (key === undefined) return undefined;
  const previous = findRunReceipt(events, sessionId, scope, { requestKey: key });
  if (previous === undefined) return undefined;
  const user = events.find(event => event.kind === 'user' && event.seq === previous.userSeq);
  if (!user || !isRunAcceptance(user.run) || user.run.payloadDigest !== digest) throw new KernelError('run_request_conflict');
  return previous;
}

export function createRunSubmissionHandler<State extends RunSession>(context: RunSubmissionContext<State>) {
  const pending = new Map<string, PendingReceipt>();
  return async (method: SubmitMethod, sessionId: string, params: HostMethodParams, caller: SubmissionCaller<State>) => {
    const { input = '', delegation, requestKey: key } = params;
    const waitForCompletion = method === 'run.start';
    const submission = await context.serialize(sessionId, async () => {
      const state = context.open(sessionId);
      const origin = runOriginOf(params.origin, waitForCompletion ? 'human' : 'controller', caller.canRecordHuman);
      const scope = origin === 'controller' ? caller.controllerScope : 'human';
      caller.authorize(state);
      const digest = runPayloadDigest(input, delegation);
      const receiptView = (receipt: DurableRunReceipt, reused: boolean) =>
        ({ ...runReceiptView(receipt, runLivenessOf(state, receipt.runId)), reused });
      const waitForOriginal = async (receipt: DurableRunReceipt) => {
        if (state.activeRunId === receipt.runId && state.operation !== undefined) return await state.operation;
        if (receipt.state === 'accepted' || receipt.state === 'interrupted') throw new KernelError('run_not_active');
        return await caller.waitForPersisted(receipt.runId, origin);
      };
      const previousPending = pending.get(sessionId);
      if (previousPending !== undefined) {
        if (key === undefined || previousPending.key !== key || previousPending.scope !== scope) throw new KernelError('run_already_running');
        if (previousPending.digest !== digest) throw new KernelError('run_request_conflict');
        return { wait: waitForCompletion ? previousPending.receipt.then(waitForOriginal)
          : previousPending.receipt.then(receipt => receiptView(receipt, true)) };
      }
      const accepted = deferredReceipt();
      const current = { scope, key, digest, receipt: accepted.promise };
      pending.set(sessionId, current);
      const cleanup = () => { if (pending.get(sessionId) === current) pending.delete(sessionId); };
      try {
        if (!waitForCompletion || key !== undefined) {
          const previous = replaySubmission(await state.session.read(), sessionId, scope, key, digest);
          if (previous !== undefined) {
            accepted.resolve(previous);
            return { wait: waitForCompletion ? waitForOriginal(previous) : Promise.resolve(receiptView(previous, true)), cleanup };
          }
        }
        context.validate(state, delegation);
        const run = createRunAcceptance(sessionId, input, delegation, scope, key, caller.provenance(origin, scope));
        // The Run claims the Session before releasing the configuration queue.
        const work = caller.execute(state, input, origin, delegation, run, userSeq => {
          accepted.resolve({
            runId: run.runId, sessionId, userSeq, state: 'accepted', acceptedAt: run.acceptedAt,
            ...(run.requestKey === undefined ? {} : { requestKey: run.requestKey }),
            ...(run.via === undefined ? {} : { via: run.via, resolvedBy: run.resolvedBy }),
          });
        });
        void work.catch(error => accepted.reject(error));
        return { wait: waitForCompletion ? work : accepted.promise.then(receipt => receiptView(receipt, false)), cleanup };
      } catch (error) {
        accepted.reject(error);
        cleanup();
        throw error;
      }
    });
    try { return await submission.wait; }
    finally { submission.cleanup?.(); }
  };
}

async function waitForRun(state: RunSession, sessionId: string, runId: string, events: SessionEvent[], scope: string) {
  const receipt = findRunReceipt(events, sessionId, scope, { runId });
  if (receipt === undefined) throw new KernelError('run_not_found');
  if (state.activeRunId === runId && state.operation !== undefined) return await state.operation;
  if (receipt.state === 'accepted' || receipt.state === 'interrupted') throw new KernelError('run_not_active');
  const result = await readRunResult(state.session.directory, workspaceIdentity(state.environment.projectRoot), sessionId, receipt);
  if (result.state === 'completed') return {
    runId, text: result.output.text ?? '', iterations: result.usage.iterations, modelCalls: result.usage.modelCalls,
    ...(result.stopReason === 'tool_completed' ? { completedBy: DELEGATION_RESULT_TOOL } : {}),
    ...(result.userSeq === undefined ? {} : { userSeq: result.userSeq }),
    ...(result.task === undefined ? {} : { task: result.task }),
    ...(result.artifactsTruncated === true ? { artifactsTruncated: true } : {}),
    artifacts: result.artifacts.filter(item => item.kind === 'file'),
    ...(Object.hasOwn(result.output, 'structured') ? { structured: result.output.structured } : {}),
    validation: result.validation,
  };
  const error = new KernelError(result.diagnostic?.code ?? 'run_failed', { diagnostics: result.diagnostic?.provider });
  if (result.usage.iterations !== null && result.usage.modelCalls !== null) {
    rememberRunSummary(error, {
      text: result.output.text ?? '', iterations: result.usage.iterations, modelCalls: result.usage.modelCalls,
      ...(result.userSeq === undefined ? {} : { userSeq: result.userSeq }),
      ...(result.task === undefined ? {} : { task: result.task }),
      ...(result.artifactsTruncated === true ? { artifactsTruncated: true as const } : {}),
      artifacts: result.artifacts.filter(item => item.kind === 'file'),
    });
  }
  throw error;
}

export async function handleRunRequest<State extends RunSession>(
  method: RunMethod, params: HostMethodParams, sessionId: string, context: RunHandlerContext<State>,
): Promise<unknown> {
  switch (method) {
    case 'run.receipt':
    case 'run.receipts':
    case 'run.result': {
      const env = await context.environmentFor(requiredString(params.projectRoot, 'projectRoot'));
      const recordPath = context.recordPathOf(sessionId, env);
      const opened = context.opened(sessionId);
      return await readRunRecord(method, params, {
        sessionId, env, recordPath, openedRoot: opened?.environment.projectRoot,
        log: opened?.session ?? createSessionLog({ directory: env.directory, id: sessionId }),
        runScopes: context.scopes,
        live: runId => runLivenessOf(context.opened(sessionId), runId),
      });
    }
    case 'run.wait': {
      const state = context.open(sessionId);
      const runId = requiredString(params.runId, 'runId');
      // 旧客户端的 origin 字段保留用于兼容，授权依据由已持久化的 Run 接受记录提供。
      if (params.origin !== undefined && params.origin !== 'human' && params.origin !== 'controller') {
        throw new KernelError('protocol_args_invalid');
      }
      const { events, scope } = await context.requireRunReference(state, runId);
      return await waitForRun(state, sessionId, runId, events, scope);
    }
    case 'run.cancel': {
      const state = context.open(sessionId);
      if (state.running === undefined) throw new KernelError('run_not_running', { detail: sessionId });
      state.running.abort();
      await context.stopRun(state);
      return { cancelled: true };
    }
    case 'run.steer': {
      const state = context.open(sessionId);
      const runId = requiredString(params.runId, 'runId');
      if (state.activeRunId !== runId) throw new KernelError('run_steer_target_mismatch');
      await context.requireRunReference(state, runId);
      const header = await state.session.header();
      if (header?.formatVersion === undefined || header.formatVersion < 3) throw new KernelError('run_steer_session_format_unsupported');
      const steering = state.runSteering;
      if (steering === undefined) throw new KernelError('run_steer_not_ready');
      let cancelledInteractionIds: string[] = [];
      const accepted = await steering.accept(context.source, requiredString(params.input, 'input'), () => {
        cancelledInteractionIds = context.acceptInput(state, runId);
      });
      return { ...accepted, cancelledInteractions: cancelledInteractionIds.length, cancelledInteractionIds };
    }
  }
}
