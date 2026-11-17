import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { ExecLogSnapshot } from '../capability/exec.js';
import { boundaryOf, workingDirectoryOf, type CapabilityConfig } from '../capability/limits.js';
import { permissionDenial, type PermissionContext } from '../kernel/permission.js';
import { resolveWithin } from '../capability/paths.js';
import { versionOf } from '../kernel/observe.js';
import type { CheckDeclaration, CheckEvent, CheckScopeSample, LiguleTestReport } from '../session/checks.js';

export const CHECK_SCOPE_FILE_BYTES = 256 * 1024;
export const CHECK_SCOPE_TOTAL_BYTES = 1024 * 1024;
export const CHECK_REPORT_LINE_BYTES = 4 * 1024;
export const CHECK_LOG_BYTES = 64 * 1024;

function scopeSample(path: string, status: CheckScopeSample['status'], exists: boolean | null, reason?: string, version: string | null = null): CheckScopeSample {
  return { path, status, exists, version, sampledAt: new Date().toISOString(), ...(reason === undefined ? {} : { reason }) };
}

export async function sampleCheckScope(config: CapabilityConfig, permission: PermissionContext,
  declaration: CheckDeclaration): Promise<CheckScopeSample[]> {
  const samples: CheckScopeSample[] = [];
  const readDenied = permission.capabilities.filesystemRead === 'unavailable' || permissionDenial(permission, 'read') !== undefined;
  let totalBytes = 0;
  for (const path of declaration.scope) {
    if (readDenied) {
      samples.push(scopeSample(path, 'unavailable', null, 'read_permission_unavailable'));
      continue;
    }
    let target: string;
    try { target = await resolveWithin(boundaryOf(config), path, { cwd: workingDirectoryOf(config) }); }
    catch { samples.push(scopeSample(path, 'unavailable', null, 'scope_path_denied')); continue; }
    let metadata;
    try { metadata = await lstat(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') samples.push(scopeSample(path, 'available', false));
      else samples.push(scopeSample(path, 'unknown', null, 'scope_stat_failed'));
      continue;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      samples.push(scopeSample(path, 'unavailable', true, 'scope_not_regular_file'));
      continue;
    }
    if (metadata.size > CHECK_SCOPE_FILE_BYTES) {
      samples.push(scopeSample(path, 'unavailable', true, 'scope_file_too_large'));
      continue;
    }
    if (totalBytes + metadata.size > CHECK_SCOPE_TOTAL_BYTES) {
      samples.push(scopeSample(path, 'unavailable', true, 'scope_sample_limit'));
      continue;
    }
    let handle;
    try {
      const flags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
      handle = await open(target, flags);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
        samples.push(scopeSample(path, 'unknown', true, 'scope_target_changed'));
        continue;
      }
      if (opened.size > CHECK_SCOPE_FILE_BYTES) {
        samples.push(scopeSample(path, 'unavailable', true, 'scope_file_too_large'));
        continue;
      }
      const buffer = Buffer.allocUnsafe(CHECK_SCOPE_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > CHECK_SCOPE_FILE_BYTES) {
        samples.push(scopeSample(path, 'unavailable', true, 'scope_file_too_large'));
        continue;
      }
      const after = await handle.stat();
      if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
        samples.push(scopeSample(path, 'unknown', true, 'scope_changed_during_sample'));
        continue;
      }
      const bytes = Buffer.from(buffer.subarray(0, length));
      const version = versionOf(bytes);
      if (!isUtf8(bytes)) samples.push(scopeSample(path, 'unavailable', true, 'scope_not_utf8', version));
      else {
        totalBytes += bytes.length;
        samples.push(scopeSample(path, 'available', true, undefined, version));
      }
    } catch {
      samples.push(scopeSample(path, 'unknown', null, 'scope_read_failed'));
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return samples;
}

export function checkLogStatus(snapshot: ExecLogSnapshot | undefined, unavailableReason?: string): CheckEvent['logStatus'] {
  if (unavailableReason !== undefined) return 'unavailable';
  if (snapshot === undefined) return unavailableReason === undefined ? 'unknown' : 'unavailable';
  const retainedBytes = snapshot.chunks.reduce((total, chunk) => total + chunk.data.length, 0);
  return snapshot.firstAvailableOffset === 0 && retainedBytes === snapshot.totalBytes ? 'complete' : 'partial';
}

function checkedReport(value: unknown): LiguleTestReport | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const report = value as Record<string, unknown>;
  if (Object.keys(report).length !== 6 || report.schema !== 'ligule-test-report' || report.version !== 1
    || ['passed', 'failed', 'skipped', 'todo'].some((key) => !Number.isSafeInteger(report[key]) || Number(report[key]) < 0)) {
    return undefined;
  }
  return { schema: 'ligule-test-report', version: 1, passed: Number(report.passed), failed: Number(report.failed),
    skipped: Number(report.skipped), todo: Number(report.todo) };
}

export function parseCheckReport(declaration: CheckDeclaration, snapshot: ExecLogSnapshot | undefined,
  logStatus: CheckEvent['logStatus']): { readonly status: CheckEvent['reportStatus']; readonly report?: LiguleTestReport; readonly reason?: string } {
  if (declaration.report === undefined) return { status: 'not_requested' };
  if (snapshot === undefined || logStatus !== 'complete') return { status: 'unverified', reason: 'execution_logs_incomplete' };
  const chunks = snapshot.chunks.filter((chunk) => chunk.stream === 'stdout').toSorted((left, right) => left.offset - right.offset);
  let nextOffset = 0;
  for (const chunk of chunks) {
    if (chunk.offset !== nextOffset) return { status: 'unverified', reason: 'report_stdout_gap' };
    nextOffset += chunk.data.length;
  }
  if (nextOffset > CHECK_LOG_BYTES) return { status: 'unverified', reason: 'report_line_too_large' };
  const stdout = Buffer.concat(chunks.map((chunk) => chunk.data));
  if (!isUtf8(stdout)) return { status: 'unverified', reason: 'report_stdout_not_utf8' };
  const lines = stdout.toString('utf8').split(/\r?\n/u).filter((line) => line.startsWith('LIGULE_TEST_REPORT_V1\t'));
  if (lines.length === 0) return { status: 'unverified', reason: 'report_missing' };
  if (lines.length !== 1 || Buffer.byteLength(lines[0]!, 'utf8') > CHECK_REPORT_LINE_BYTES) {
    return { status: 'unverified', reason: 'report_ambiguous_or_too_large' };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(lines[0]!.slice('LIGULE_TEST_REPORT_V1\t'.length)); }
  catch { return { status: 'unverified', reason: 'report_json_invalid' }; }
  const report = checkedReport(parsed);
  if (report === undefined) return { status: 'unverified', reason: 'report_schema_unsupported' };
  const total = report.passed + report.failed + report.skipped + report.todo;
  if (total === 0) return { status: 'zero_tests', report };
  return report.failed > 0 ? { status: 'reported_fail', report } : { status: 'reported_pass', report };
}

export function checkEventOf({
  sessionId, runId, callId, executionId, declaration, executionState, exitCode, errorCode, logs, logUnavailableReason,
  scopeStart, scopeEnd, knownScopedChange,
}: {
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly executionId: string;
  readonly declaration: CheckDeclaration;
  readonly executionState: CheckEvent['executionState'];
  readonly exitCode?: number;
  readonly errorCode?: string;
  readonly logs?: ExecLogSnapshot;
  readonly logUnavailableReason?: string;
  readonly scopeStart: readonly CheckScopeSample[];
  readonly scopeEnd: readonly CheckScopeSample[];
  readonly knownScopedChange: boolean;
}): Omit<CheckEvent, 'seq'> {
  const logStatus = checkLogStatus(logs, logUnavailableReason);
  const report = parseCheckReport(declaration, logs, logStatus);
  const commandStatus = executionState === 'unknown' ? 'unknown'
    : executionState === 'exited' && exitCode !== undefined
      ? declaration.expectedExitCodes.includes(exitCode) ? 'met' : 'not_met'
      : 'not_met';
  const samplesAvailable = scopeStart.length === declaration.scope.length && scopeEnd.length === declaration.scope.length
    && scopeStart.every((sample) => sample.status === 'available') && scopeEnd.every((sample) => sample.status === 'available');
  const changedAtSamples = samplesAvailable && scopeStart.some((sample, index) =>
    sample.path !== scopeEnd[index]?.path || sample.exists !== scopeEnd[index]?.exists || sample.version !== scopeEnd[index]?.version);
  const scopeStatus = knownScopedChange || changedAtSamples ? 'stale' : samplesAvailable ? 'sampled' : 'unverified';
  return {
    kind: 'check', sessionId, runId, callId, executionId, at: new Date().toISOString(), declaration,
    executionState, exitCode: exitCode ?? null, commandStatus,
    ...(errorCode === undefined ? {} : { errorCode }),
    reportStatus: report.status, ...(report.report === undefined ? {} : { report: report.report }),
    ...(report.reason === undefined ? {} : { reportReason: report.reason }),
    logStatus, logTotalBytes: logs?.totalBytes ?? 0, logFirstAvailableOffset: logs?.firstAvailableOffset ?? 0,
    scopeStart, scopeEnd, scopeStatus, coverage: 'session_scope_samples_only',
  };
}
