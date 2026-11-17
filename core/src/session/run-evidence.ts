import type { RunCheckReference, RunFileChangeReference } from '../delegation.js';
import type { SessionEvent } from './format.js';
import { checkedFileChangeFact } from './file-changes.js';
import { checkedCheckDeclaration, checkedCheckEvent, type CheckEvent } from './checks.js';

const MAX_RUN_FILE_CHANGES = 256;
const MAX_RUN_CHECKS = 64;

export interface RunEvidenceReferences {
  readonly fileChanges: readonly RunFileChangeReference[];
  readonly fileChangesTruncated?: true;
  readonly checks: readonly RunCheckReference[];
  readonly checksTruncated?: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function runEvidenceReferences(events: readonly SessionEvent[], runId: string): RunEvidenceReferences {
  const fileChanges: RunFileChangeReference[] = [];
  let fileChangesTruncated = false;
  const checks: RunCheckReference[] = [];
  let checksTruncated = false;
  const checkEvents = events.flatMap((event) => {
    if (event.kind !== 'check') return [];
    const check = checkedCheckEvent(event);
    return check?.runId === runId ? [{ event, check }] : [];
  });
  const terminalByCall = new Map<string, { readonly executionId: string; readonly state: string }>();
  for (const event of events) {
    if (event.kind === 'execution' && event.runId === runId && typeof event.callId === 'string' && typeof event.executionId === 'string') {
      const prior = terminalByCall.get(event.callId);
      terminalByCall.set(event.callId, { executionId: event.executionId, state: String(event.state ?? prior?.state ?? 'unknown') });
    }
    if (event.kind !== 'tool' || event.runId !== runId || typeof event.callId !== 'string' || !Array.isArray(event.fileChanges)) continue;
    for (const value of event.fileChanges) {
      const change = checkedFileChangeFact(value);
      if (change === undefined) continue;
      if (fileChanges.length >= MAX_RUN_FILE_CHANGES) { fileChangesTruncated = true; continue; }
      if (typeof event.seq !== 'number') continue;
      fileChanges.push({ eventSeq: event.seq, callId: event.callId, path: change.path,
        operation: change.operation, outcome: change.outcome, baselineStatus: change.baselineStatus,
        observedStatus: change.observedStatus, changedFromBaseline: change.changedFromBaseline });
    }
  }
  const laterChangesByCheck = (check: CheckEvent, eventSeq: number): boolean => events.some((event) => event.kind === 'tool' && event.runId === runId && event.seq > eventSeq
      && Array.isArray(event.fileChanges) && event.fileChanges.some((value) => {
        const change = checkedFileChangeFact(value);
        return change !== undefined && check.declaration.scope.includes(change.path) && change.outcome !== 'unchanged';
      }));
  const declarationCalls = events.flatMap((event) => {
    if (event.kind !== 'tool' || event.runId !== runId || typeof event.callId !== 'string' || !isRecord(event.args)) return [];
    const declaration = checkedCheckDeclaration(event.args.check);
    if (declaration === undefined) return [];
    return [{ event, declaration }];
  });
  const seenCalls = new Set<string>();
  for (const { event, declaration } of declarationCalls) {
    const callId = event.callId as string;
    if (seenCalls.has(callId)) continue;
    seenCalls.add(callId);
    const recorded = checkEvents.find((item) => item.check.callId === callId);
    const execution = terminalByCall.get(callId);
    let summary: RunCheckReference;
    if (recorded !== undefined) {
      const check = recorded.check;
      const scopeStatus = check.scopeStatus === 'sampled' && recorded.event.seq !== undefined
        && laterChangesByCheck(check, recorded.event.seq) ? 'stale' : check.scopeStatus;
      summary = {
        ...(typeof recorded.event.seq === 'number' ? { eventSeq: recorded.event.seq } : {}),
        executionId: check.executionId, callId, name: check.declaration.name, status: 'completed',
        commandStatus: check.commandStatus, reportStatus: check.reportStatus, scopeStatus, logStatus: check.logStatus,
        ...(check.errorCode === undefined ? {} : { errorCode: check.errorCode }),
        ...(check.report === undefined ? {} : { report: {
          passed: check.report.passed, failed: check.report.failed, skipped: check.report.skipped, todo: check.report.todo,
        } }),
      };
    } else {
      summary = { ...(execution === undefined ? {} : { executionId: execution.executionId }), callId, name: declaration.name,
        status: execution === undefined ? 'not_run' : 'unknown', commandStatus: 'unknown',
        reportStatus: declaration.report === undefined ? 'not_requested' : 'unverified', scopeStatus: 'unverified' };
    }
    if (checks.length >= MAX_RUN_CHECKS) { checksTruncated = true; continue; }
    checks.push(summary);
  }
  return {
    fileChanges,
    ...(fileChangesTruncated ? { fileChangesTruncated: true as const } : {}),
    checks,
    ...(checksTruncated ? { checksTruncated: true as const } : {}),
  };
}
