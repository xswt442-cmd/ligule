import { checkedExecutionLogReference, type ExecutionLogReference } from './storage/execution-log.js';

export interface CheckDeclaration {
  readonly name: string;
  readonly purpose: string;
  readonly expectedExitCodes: readonly number[];
  readonly scope: readonly string[];
  readonly report?: { readonly format: 'ligule-test-report-v1' };
}

export const CHECK_DECLARATION_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false, properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    purpose: { type: 'string', minLength: 1, maxLength: 512 },
    expectedExitCodes: { type: 'array', minItems: 1, maxItems: 16,
      items: { type: 'integer', minimum: -255, maximum: 255 } },
    scope: { type: 'array', minItems: 1, maxItems: 32,
      items: { type: 'string', minLength: 1, maxLength: 2048 } },
    report: { type: 'object', additionalProperties: false, properties: {
      format: { type: 'string', enum: ['ligule-test-report-v1'] },
    }, required: ['format'] },
  }, required: ['name', 'purpose', 'expectedExitCodes', 'scope'],
};

export interface CheckScopeSample {
  readonly path: string;
  readonly status: 'available' | 'unavailable' | 'unknown';
  readonly exists: boolean | null;
  readonly version: string | null;
  readonly sampledAt: string;
  readonly reason?: string;
}

export interface LiguleTestReport {
  readonly schema: 'ligule-test-report';
  readonly version: 1;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly todo: number;
}

export type CheckCommandStatus = 'met' | 'not_met' | 'unknown';
export type CheckReportStatus = 'not_requested' | 'reported_pass' | 'reported_fail' | 'zero_tests' | 'unverified';
export type CheckLogStatus = 'complete' | 'partial' | 'unavailable' | 'unknown';
export type CheckScopeStatus = 'sampled' | 'stale' | 'unverified';

export interface CheckEvent extends Record<string, unknown> {
  readonly kind: 'check';
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly executionId: string;
  readonly at: string;
  /** 命令实际开始的时刻；旧记录没有这个字段，读取方必须当作未知。 */
  readonly startedAt?: string;
  /** 命令结束的时刻；旧记录没有这个字段，读取方必须当作未知。 */
  readonly endedAt?: string;
  /** 指向这份检查执行日志的引用；旧记录没有这个字段，读取方必须当作未知。 */
  readonly logsRef?: ExecutionLogReference;
  readonly declaration: CheckDeclaration;
  readonly executionState: 'exited' | 'cancelled' | 'failed' | 'unknown';
  readonly exitCode: number | null;
  readonly errorCode?: string;
  readonly commandStatus: CheckCommandStatus;
  readonly reportStatus: CheckReportStatus;
  readonly report?: LiguleTestReport;
  readonly reportReason?: string;
  readonly logStatus: CheckLogStatus;
  readonly logTotalBytes: number;
  readonly logFirstAvailableOffset: number;
  readonly scopeStart: readonly CheckScopeSample[];
  readonly scopeEnd: readonly CheckScopeSample[];
  readonly scopeStatus: CheckScopeStatus;
  readonly coverage: 'session_scope_samples_only';
}

const CHECK_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/u;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,79}$/u;
const VERSION = /^[a-f0-9]{16}$/u;
const RUN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validScopePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048
    && !value.startsWith('/') && !value.includes('\\') && !/^[A-Za-z]:/u.test(value)
    && !/[\u0000-\u001f\u007f:*?"<>|]/u.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export function checkedCheckDeclaration(value: unknown): CheckDeclaration | undefined {
  if (!isRecord(value) || Object.keys(value).some(key => !['name', 'purpose', 'expectedExitCodes', 'scope', 'report'].includes(key))
    || typeof value.name !== 'string' || !CHECK_NAME.test(value.name) || value.name.trim() === ''
    || typeof value.purpose !== 'string' || value.purpose.trim() === '' || value.purpose.length > 512
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.purpose)
    || !Array.isArray(value.expectedExitCodes) || value.expectedExitCodes.length === 0 || value.expectedExitCodes.length > 16
    || value.expectedExitCodes.some(code => !Number.isSafeInteger(code) || Number(code) < -255 || Number(code) > 255)
    || new Set(value.expectedExitCodes).size !== value.expectedExitCodes.length
    || !Array.isArray(value.scope) || value.scope.length === 0 || value.scope.length > 32
    || value.scope.some(path => !validScopePath(path)) || new Set(value.scope).size !== value.scope.length) return undefined;
  let report: CheckDeclaration['report'];
  if (value.report !== undefined) {
    if (!isRecord(value.report) || Object.keys(value.report).length !== 1 || value.report.format !== 'ligule-test-report-v1') return undefined;
    report = { format: 'ligule-test-report-v1' };
  }
  return {
    name: value.name,
    purpose: value.purpose,
    expectedExitCodes: value.expectedExitCodes as number[],
    scope: value.scope as string[],
    ...(report === undefined ? {} : { report }),
  };
}

export function checkedCheckScopeSamples(value: unknown, declaration: CheckDeclaration): CheckScopeSample[] | undefined {
  if (!Array.isArray(value) || value.length !== declaration.scope.length) return undefined;
  const samples: CheckScopeSample[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || item.path !== declaration.scope[index]
      || Object.keys(item).some(key => !['path', 'status', 'exists', 'version', 'sampledAt', 'reason'].includes(key))
      || !['available', 'unavailable', 'unknown'].includes(String(item.status))
      || (item.exists !== null && typeof item.exists !== 'boolean')
      || (item.version !== null && (typeof item.version !== 'string' || !VERSION.test(item.version)))
      || typeof item.sampledAt !== 'string' || !Number.isFinite(Date.parse(item.sampledAt))
      || (item.reason !== undefined && (typeof item.reason !== 'string' || !ERROR_CODE.test(item.reason)))) return undefined;
    samples.push({ path: item.path as string, status: item.status as CheckScopeSample['status'],
      exists: item.exists as boolean | null, version: item.version as string | null, sampledAt: item.sampledAt,
      ...(item.reason === undefined ? {} : { reason: item.reason as string }) });
  }
  return samples;
}

function sameSample(left: CheckScopeSample, right: CheckScopeSample): boolean {
  return left.status === 'available' && right.status === 'available'
    && left.exists === right.exists && left.version === right.version;
}

export function checkedCheckEvent(value: unknown): CheckEvent | undefined {
  if (!isRecord(value) || value.kind !== 'check' || value.ignorable === true
    || Object.keys(value).some(key => !['seq', 'kind', 'sessionId', 'runId', 'callId', 'executionId', 'at', 'startedAt', 'endedAt',
      'logsRef', 'declaration',
      'executionState', 'exitCode', 'commandStatus', 'reportStatus', 'report', 'reportReason', 'logStatus', 'logTotalBytes',
      'errorCode', 'logFirstAvailableOffset', 'scopeStart', 'scopeEnd', 'scopeStatus', 'coverage'].includes(key))
    || !safeId(value.sessionId) || !RUN_UUID.test(String(value.runId)) || !safeId(value.callId) || !RUN_UUID.test(String(value.executionId))
    || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))
    || (value.startedAt !== undefined && (typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))))
    || (value.endedAt !== undefined && (typeof value.endedAt !== 'string' || !Number.isFinite(Date.parse(value.endedAt))))
    || (typeof value.startedAt === 'string' && typeof value.endedAt === 'string'
      && Date.parse(value.endedAt) < Date.parse(value.startedAt))
    || (value.logsRef !== undefined && checkedExecutionLogReference(value.logsRef) === undefined)) return undefined;
  const declaration = checkedCheckDeclaration(value.declaration);
  if (declaration === undefined) return undefined;
  if (!['exited', 'cancelled', 'failed', 'unknown'].includes(String(value.executionState))
    || (value.exitCode !== null && !Number.isSafeInteger(value.exitCode))
    || (value.errorCode !== undefined && (typeof value.errorCode !== 'string' || !ERROR_CODE.test(value.errorCode)))
    || !['met', 'not_met', 'unknown'].includes(String(value.commandStatus))
    || !['not_requested', 'reported_pass', 'reported_fail', 'zero_tests', 'unverified'].includes(String(value.reportStatus))
    || (declaration.report === undefined && value.reportStatus !== 'not_requested')
    || (declaration.report !== undefined && value.reportStatus === 'not_requested')
    || (value.reportReason !== undefined && (typeof value.reportReason !== 'string' || !ERROR_CODE.test(value.reportReason)))
    || !['complete', 'partial', 'unavailable', 'unknown'].includes(String(value.logStatus))
    || !Number.isSafeInteger(value.logTotalBytes) || Number(value.logTotalBytes) < 0
    || !Number.isSafeInteger(value.logFirstAvailableOffset) || Number(value.logFirstAvailableOffset) < 0
    || Number(value.logFirstAvailableOffset) > Number(value.logTotalBytes)
    || value.coverage !== 'session_scope_samples_only') return undefined;
  let report: LiguleTestReport | undefined;
  if (value.report !== undefined) {
    const counts = value.report;
    if (!isRecord(counts) || Object.keys(counts).length !== 6
      || Object.keys(counts).some(key => !['schema', 'version', 'passed', 'failed', 'skipped', 'todo'].includes(key))
      || counts.version !== 1
      || counts.schema !== 'ligule-test-report' || ['passed', 'failed', 'skipped', 'todo'].some(key =>
        !Number.isSafeInteger(counts[key]) || Number(counts[key]) < 0)) return undefined;
    report = { schema: 'ligule-test-report', version: 1, passed: Number(counts.passed), failed: Number(counts.failed),
      skipped: Number(counts.skipped), todo: Number(counts.todo) };
  }
  if (report !== undefined && ((value.reportStatus === 'zero_tests'
      && report.passed + report.failed + report.skipped + report.todo !== 0)
    || (value.reportStatus === 'reported_fail' && report.failed === 0)
    || (value.reportStatus === 'reported_pass' && report.failed !== 0))) return undefined;
  if (value.executionState === 'exited' && typeof value.exitCode === 'number'
    && value.commandStatus !== (declaration.expectedExitCodes.includes(value.exitCode) ? 'met' : 'not_met')) return undefined;
  if ((value.executionState === 'cancelled' || value.executionState === 'failed') && value.commandStatus !== 'not_met') return undefined;
  if (value.executionState === 'unknown' && value.commandStatus !== 'unknown') return undefined;
  const scopeStart = checkedCheckScopeSamples(value.scopeStart, declaration);
  const scopeEnd = checkedCheckScopeSamples(value.scopeEnd, declaration);
  if (scopeStart === undefined || scopeEnd === undefined
    || !['sampled', 'stale', 'unverified'].includes(String(value.scopeStatus))) return undefined;
  if (value.scopeStatus === 'sampled'
    && (scopeStart.some(sample => sample.status !== 'available') || scopeEnd.some(sample => sample.status !== 'available')
      || scopeStart.some((sample, index) => !sameSample(sample, scopeEnd[index]!)))) return undefined;
  return {
    kind: 'check', sessionId: value.sessionId as string, runId: value.runId as string, callId: value.callId as string,
    executionId: value.executionId as string,
    at: value.at as string,
    ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt as string }),
    ...(value.endedAt === undefined ? {} : { endedAt: value.endedAt as string }),
    ...(value.logsRef === undefined ? {} : { logsRef: checkedExecutionLogReference(value.logsRef)! }),
    declaration, executionState: value.executionState as CheckEvent['executionState'], exitCode: value.exitCode as number | null,
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode as string }),
    commandStatus: value.commandStatus as CheckCommandStatus, reportStatus: value.reportStatus as CheckReportStatus,
    ...(report === undefined ? {} : { report }), ...(value.reportReason === undefined ? {} : { reportReason: value.reportReason as string }),
    logStatus: value.logStatus as CheckLogStatus, logTotalBytes: Number(value.logTotalBytes),
    logFirstAvailableOffset: Number(value.logFirstAvailableOffset), scopeStart, scopeEnd,
    scopeStatus: value.scopeStatus as CheckScopeStatus, coverage: 'session_scope_samples_only',
  };
}
