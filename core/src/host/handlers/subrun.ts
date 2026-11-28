import { KernelError } from '../../kernel/error.js';
import type { LoggerBackend } from '../../kernel/log.js';
import type { SubagentRuntime } from '../../tools/subagent.js';
import { requiredString, type HostMethodParams } from '../protocol.js';
import type { HostSessionState } from '../types.js';

type SubrunSession = Pick<HostSessionState, 'activeRunId' | 'running' | 'permission' | 'session' | 'subagents'>;
type SubrunMethod = 'subrun.start' | 'subrun.list' | 'subrun.status' | 'subrun.message' | 'subrun.wait' | 'subrun.cancel'
  | 'preset.list' | 'preset.preview';

interface SubrunContext {
  requireParent(runId: string): Promise<unknown>;
  assertPresetScope(): void;
  settleAsks(runId: string): void;
  readonly source: 'human' | 'controller';
  readonly logger?: Pick<LoggerBackend, 'log'>;
}

function overridesOf(params: HostMethodParams): Parameters<SubagentRuntime['previewPreset']>[1] {
  const { mode, outputTokens, thinkingEffort, loopIterations, modelCalls, outputSchema } = params;
  return {
    ...(mode === undefined ? {} : { mode: mode as Parameters<SubagentRuntime['previewPreset']>[1]['mode'] }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(thinkingEffort === undefined ? {} : { thinkingEffort: thinkingEffort as Parameters<SubagentRuntime['previewPreset']>[1]['thinkingEffort'] }),
    ...(loopIterations === undefined ? {} : { loopIterations }),
    ...(modelCalls === undefined ? {} : { modelCalls }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
}

function pageOf({ cursor, limit }: HostMethodParams) {
  return {
    ...(cursor === undefined ? {} : { cursor: requiredString(cursor, 'cursor') }),
    ...(limit === undefined ? {} : { limit }),
  };
}

async function startSubrun(
  sessionId: string, state: SubrunSession, parentRunId: string, params: HostMethodParams, { source, logger }: SubrunContext,
) {
  if (state.activeRunId !== parentRunId || state.running === undefined) throw new KernelError('subagent_parent_not_active');
  const task = requiredString(params.task, 'task');
  const presetId = params.presetId === undefined ? undefined : requiredString(params.presetId, 'presetId');
  const child = await state.subagents.start({ task, ...(presetId === undefined ? {} : { presetId }), ...overridesOf(params) }, {
    signal: state.running.signal,
    permission: state.permission,
    runId: parentRunId,
  }, source);
  const taskLabel = Array.from(task.trim()).slice(0, 256).join('');
  try {
    await state.session.append({ kind: 'subrunStarted', ignorable: true, source, parentRunId,
      subrunId: child.subrunId, childSessionId: child.sessionId, childRunId: child.runId,
      ...(presetId === undefined ? {} : { presetId }), taskLabel, startedAt: new Date().toISOString() });
  } catch (cause) {
    let cleanup: string;
    try {
      const cancellation = await state.subagents.cancel({ subrunId: child.subrunId, runId: child.runId, parentRunId });
      if (cancellation.cancelRequested) {
        const settled = await state.subagents.wait([child.subrunId], parentRunId, 30_000);
        cleanup = settled.timedOut ? 'pending' : settled.subruns[0]?.state ?? 'unknown';
      } else {
        cleanup = cancellation.state;
      }
    } catch {
      cleanup = 'failed';
    }
    logger?.log?.('subrun relationship could not be recorded', {
      code: 'subrun_activity_record_failed', sessionId, parentRunId,
      subrunId: child.subrunId, childRunId: child.runId, cleanup,
    });
    throw new KernelError('subrun_activity_record_failed', { cause, detail: `child=${child.subrunId}; cleanup=${cleanup}` });
  }
  return child;
}

export async function handleSubrunRequest(
  method: SubrunMethod, params: HostMethodParams, sessionId: string, state: SubrunSession, context: SubrunContext,
): Promise<unknown> {
  if (method === 'preset.list') {
    context.assertPresetScope();
    return await state.subagents.listPresets(pageOf(params));
  }
  if (method === 'preset.preview') {
    context.assertPresetScope();
    const parentRunId = params.parentRunId === undefined
      ? state.activeRunId : requiredString(params.parentRunId, 'parentRunId');
    if (parentRunId !== undefined) {
      await context.requireParent(parentRunId);
      if (state.activeRunId !== parentRunId) throw new KernelError('subagent_parent_not_active');
    }
    return await state.subagents.previewPreset(requiredString(params.presetId, 'presetId'), overridesOf(params), {
      permission: state.permission,
      ...(parentRunId === undefined ? {} : { runId: parentRunId }),
    });
  }
  const parentRunId = requiredString(params.parentRunId, 'parentRunId');
  await context.requireParent(parentRunId);
  switch (method) {
    case 'subrun.start':
      return await startSubrun(sessionId, state, parentRunId, params, context);
    case 'subrun.list':
      return await state.subagents.list(parentRunId, pageOf(params));
    case 'subrun.status':
      return await state.subagents.status(requiredString(params.subrunId, 'subrunId'), parentRunId);
    case 'subrun.message': {
      const runId = requiredString(params.runId, 'runId');
      return await state.subagents.message({
        subrunId: requiredString(params.subrunId, 'subrunId'), runId, parentRunId, input: requiredString(params.input, 'input'),
      }, context.source, () => context.settleAsks(runId));
    }
    case 'subrun.wait':
      if (!Array.isArray(params.subrunIds)) throw new KernelError('protocol_args_invalid');
      return await state.subagents.wait(params.subrunIds, parentRunId, params.timeoutMs ?? 30_000);
    case 'subrun.cancel':
      return await state.subagents.cancel({
        subrunId: requiredString(params.subrunId, 'subrunId'), runId: requiredString(params.runId, 'runId'), parentRunId,
      });
  }
}
