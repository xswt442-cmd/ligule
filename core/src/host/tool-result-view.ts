// 工具结果读模型：从会话事件里重建一次工具调用的状态、分页输出、执行句柄、检查与文件变化。
// 只报告事件中真实记录过的字段；旧记录缺少字节数或完整性声明时保持未知，不反推。
import { createHash } from 'node:crypto';
import { KernelError } from '../kernel/error.js';
import type { SessionEvent } from '../session/format.js';
import { checkedCheckDeclaration } from '../session/checks.js';
import { effectiveCheckScopeStatus } from '../session/run-evidence.js';
import { checkedToolResultSpillReference, decodeToolResultCursor, encodeToolResultCursor, readVerifiedToolResultSpillPage } from '../session/tool-result.js';
import { checkedFileChangeFact } from '../session/file-changes.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ToolResultScope = {
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly params: { readonly cursor?: string; readonly limitBytes?: number };
  /** 已通过 Run 可见性校验的事件。 */
  readonly events: readonly SessionEvent[];
  readonly directory: string;
  readonly activeRunId: string | undefined;
  readonly liveness: (runId: string) => boolean;
};

const isRunAcceptance = (value: unknown): value is { readonly runId: string } => isRecord(value) && typeof value.runId === 'string';

export async function readToolResult(scope: ToolResultScope) {
  const { sessionId, runId, callId, params, events, directory, activeRunId, liveness } = scope;
  const runOwners = new Map<number, string | undefined>();
  let currentRunId: string | undefined;
  for (const event of events) {
    if (event.kind === 'user') currentRunId = isRunAcceptance(event.run) ? event.run.runId : undefined;
    runOwners.set(event.seq, currentRunId);
  }
  const assistantCall = events.find((event) => event.kind === 'assistant' && runOwners.get(event.seq) === runId
    && Array.isArray(event.toolCalls) && event.toolCalls.some((call) => isRecord(call) && call.id === callId));
  if (assistantCall === undefined) throw new KernelError('tool_call_not_found');
  const assistantToolCall = Array.isArray(assistantCall.toolCalls)
    ? assistantCall.toolCalls.find((call) => isRecord(call) && call.id === callId) as Record<string, unknown> | undefined
    : undefined;
  const results = events.filter((event) => event.kind === 'tool' && event.callId === callId
    && event.seq > assistantCall.seq && (event.runId === runId || (event.runId === undefined && runOwners.get(event.seq) === runId)));
  if (results.length > 1) return { sessionId, runId, callId, state: 'unknown', code: 'tool_result_duplicate' };
  const resultEvent = results[0];
  const activity = events.filter((event) => event.kind === 'toolActivity' && event.sessionId === sessionId
    && event.runId === runId && event.callId === callId && event.seq > assistantCall.seq).at(-1);
  const executionEvent = events.filter((event) => event.kind === 'execution' && event.sessionId === sessionId
    && event.runId === runId && event.callId === callId).at(-1);
  const executionLost = executionEvent !== undefined && ['accepted', 'started'].includes(String(executionEvent.state))
    && activeRunId !== runId;
  const callArgs = isRecord(assistantToolCall?.args) ? assistantToolCall.args : undefined;
  const declaredCheck = checkedCheckDeclaration(executionEvent?.check
    ?? (isRecord(callArgs?.check) ? callArgs.check : undefined));
  const checkEvent = executionEvent === undefined ? undefined : events.findLast((event) => event.kind === 'check'
    && event.executionId === executionEvent.executionId && event.sessionId === sessionId && event.runId === runId && event.callId === callId);
  const checkFields: Record<string, unknown> = isRecord(checkEvent) ? checkEvent : {};
  const check = checkEvent === undefined
    ? declaredCheck === undefined ? undefined : {
      status: executionEvent === undefined
        ? liveness(runId) && activity !== undefined ? 'running' : 'not_run'
        : ['accepted', 'started'].includes(String(executionEvent.state))
          ? liveness(runId) ? 'running' : 'unknown'
          : 'unknown',
      declaration: declaredCheck,
    }
    : {
      status: 'completed',
      declaration: declaredCheck ?? checkEvent.declaration,
      eventSeq: checkEvent.seq,
      commandStatus: checkEvent.commandStatus,
      reportStatus: checkEvent.reportStatus,
      logStatus: checkEvent.logStatus,
      scopeStatus: effectiveCheckScopeStatus(events, runId, checkEvent),
      ...(typeof checkFields.startedAt === 'string' ? { startedAt: checkFields.startedAt } : {}),
      ...(typeof checkFields.endedAt === 'string' ? { endedAt: checkFields.endedAt } : {}),
      ...(isRecord(checkFields.logsRef) ? { logsRef: checkFields.logsRef } : {}),
      ...(typeof checkEvent.errorCode === 'string' ? { errorCode: checkEvent.errorCode } : {}),
      ...(isRecord(checkEvent.report) ? { report: checkEvent.report } : {}),
      ...(typeof checkEvent.reportReason === 'string' ? { reportReason: checkEvent.reportReason } : {}),
    };
  const logTotalBytes = executionEvent !== undefined && Number.isSafeInteger(executionEvent.logTotalBytes)
    ? Number(executionEvent.logTotalBytes) : 0;
  const logFirstAvailableOffset = executionEvent !== undefined && Number.isSafeInteger(executionEvent.logFirstAvailableOffset)
    ? Number(executionEvent.logFirstAvailableOffset) : 0;
  const logsReference = executionEvent !== undefined && isRecord(executionEvent.logsRef)
    && Number.isSafeInteger(executionEvent.logsRef.bytes) ? executionEvent.logsRef : undefined;
  const logUnavailableReason = executionEvent !== undefined && typeof executionEvent.logUnavailableReason === 'string'
    ? executionEvent.logUnavailableReason : undefined;
  const execution = executionEvent === undefined ? null : {
    executionId: executionEvent.executionId,
    state: executionLost ? 'unknown' : executionEvent.state,
    ...(Number.isSafeInteger(executionEvent.exitCode) ? { exitCode: executionEvent.exitCode } : {}),
    ...(executionLost ? { errorCode: 'execution_result_unknown' }
      : typeof executionEvent.errorCode === 'string' ? { errorCode: executionEvent.errorCode } : {}),
    ...(executionEvent.cancelRequested === true ? { cancelRequested: true } : {}),
    ...(executionEvent.deadlineExceeded === true ? { deadlineExceeded: true } : {}),
    ...(executionEvent.cleanupPending === true ? { cleanupPending: true } : {}),
    pipeBytes: logTotalBytes,
    retainedPipeBytes: Math.max(0, logTotalBytes - logFirstAvailableOffset),
    logFirstAvailableOffset,
    logAvailable: logsReference !== undefined || (logTotalBytes === 0 && logUnavailableReason === undefined),
    ...(logsReference === undefined ? {} : { logsRefBytes: logsReference.bytes }),
    ...(logUnavailableReason === undefined ? {} : { logUnavailableReason }),
  };
  if (resultEvent === undefined) {
    const live = liveness(runId) && activity !== undefined;
    const phase = live ? activity.phase : undefined;
    return { sessionId, runId, callId, tool: assistantToolCall?.name,
      state: phase === 'awaiting_approval' ? 'awaiting_approval' : phase === 'awaiting_user' ? 'awaiting_user'
        : live && phase === 'started' ? 'running' : 'unknown',
      ...(phase === undefined ? {} : { lastActivity: phase }), execution,
      ...(check === undefined ? {} : { check }),
      ...(!live ? { code: 'tool_result_unknown' } : {}),
    };
  }

  const result = isRecord(resultEvent.result) ? resultEvent.result : undefined;
  if (result === undefined) return { sessionId, runId, callId, tool: resultEvent.tool, state: 'unknown', code: 'tool_result_invalid', execution };
  const recoveredUnknown = result.kind === undefined && result.failed === true && result.code === 'tool_outcome_unknown';
  if (!recoveredUnknown && ((result.kind !== 'result' && result.kind !== 'refusal' && result.kind !== 'failure')
    || typeof result.failed !== 'boolean' || (result.kind === 'result' && result.failed)
    || (result.kind !== 'result' && !result.failed))) {
    return { sessionId, runId, callId, tool: resultEvent.tool, state: 'unknown', eventSeq: resultEvent.seq,
      code: 'tool_result_invalid', execution };
  }
  const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? '');
  const contentBytes = Buffer.from(content ?? '', 'utf8');
  const reference = checkedToolResultSpillReference(result.spillRef);
  const isSpilled = typeof result.spilled === 'string';
  const recordedStorageStatus = resultEvent.storageStatus === 'inline' || resultEvent.storageStatus === 'spill'
    || resultEvent.storageStatus === 'legacy_unverified'
    ? resultEvent.storageStatus
    : reference !== undefined ? 'spill' : isSpilled ? 'legacy_unverified' : 'inline';
  // 只报事件里真实记录过的数字。旧记录缺少这些字段时保持 null（未知），不从存活内容反推完整性与字节数：
  // 反推会把“没留下证据”说成“已知完整”，读取路径不同还会给出不同答案。
  const returnedValueBytes = Number.isSafeInteger(resultEvent.returnedValueBytes) && Number(resultEvent.returnedValueBytes) >= 0
    ? Number(resultEvent.returnedValueBytes) : null;
  const storedBytes = Number.isSafeInteger(resultEvent.storedBytes) && Number(resultEvent.storedBytes) >= 0
    ? Number(resultEvent.storedBytes) : reference?.bytes ?? null;
  const modelVisibleBytes = Number.isSafeInteger(resultEvent.modelVisibleBytes) && Number(resultEvent.modelVisibleBytes) >= 0
    ? Number(resultEvent.modelVisibleBytes) : null;
  const spillReferenceMatches = reference !== undefined && reference.name === result.spilled
    && reference.bytes === storedBytes;
  const storageStatus = isSpilled && !spillReferenceMatches ? 'legacy_unverified' : recordedStorageStatus;
  let page: Record<string, unknown> | null = null;
  let storedComplete: boolean | null = typeof resultEvent.storedComplete === 'boolean' ? resultEvent.storedComplete : null;
  if (!isSpilled || spillReferenceMatches) {
    const digest = spillReferenceMatches
      ? reference.sha256 : createHash('sha256').update(contentBytes).digest('hex');
    const cursorIdentity = { sessionId, runId, callId, eventSeq: resultEvent.seq, sha256: digest };
    const offset = params.cursor === undefined ? 0 : decodeToolResultCursor(params.cursor, cursorIdentity);
    const limitBytes = typeof params.limitBytes === 'number' ? params.limitBytes : 4_096;
    const bytes = spillReferenceMatches
      ? await readVerifiedToolResultSpillPage(directory, reference, offset, limitBytes)
      : contentBytes.subarray(offset, Math.min(contentBytes.length, offset + limitBytes));
    const nextOffset = offset + bytes.length;
    const completeBytes = spillReferenceMatches ? reference.bytes : contentBytes.length;
    if (offset > completeBytes) throw new KernelError('tool_result_cursor_invalid');
    // 完整与否只由事件自己声明；这里翻页成功不代表当时保存的内容完整。
    const done = nextOffset >= completeBytes;
    page = { offset, bytes: bytes.length, dataBase64: bytes.toString('base64'), done,
      nextCursor: done ? null : encodeToolResultCursor(cursorIdentity, nextOffset),
      integrity: spillReferenceMatches ? 'verified' : 'inline' };
  }
  const status = recoveredUnknown ? 'unknown' : result.code === 'tool_skipped' ? 'skipped'
    : result.kind === 'refusal' ? 'refused' : result.kind === 'failure' ? 'failed' : 'completed';
  const fileChanges = Array.isArray(resultEvent.fileChanges)
    ? resultEvent.fileChanges.map(checkedFileChangeFact).filter((change): change is NonNullable<typeof change> => change !== undefined)
    : [];
  return { sessionId, runId, callId, tool: resultEvent.tool, state: status, eventSeq: resultEvent.seq,
    result: { kind: recoveredUnknown ? 'unknown' : result.kind, ...(typeof result.code === 'string' ? { code: result.code } : {}),
      ...(typeof result.reason === 'string' ? { reason: result.reason } : {}) },
    output: { returnedValueBytes, modelVisibleBytes, storageStatus, storedBytes, storedComplete, page }, execution,
    ...(check === undefined ? {} : { check }),
    ...(fileChanges.length === 0 ? {} : { fileChanges }) };
}
