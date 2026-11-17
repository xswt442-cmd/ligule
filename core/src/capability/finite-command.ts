import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { KernelError } from '../errors.js';
import type { TaskWork } from '../kernel/task-budget.js';
import { decode, type ExecControlArguments, type ExecLogSnapshot, type ManagedExecLease } from './exec.js';
import {
  executionLogEncodedBytes, MAX_EXECUTION_LOG_RAW_BYTES, readExecutionLog, removeExecutionLog, scanExecutionLogs,
  writeExecutionLog, type ExecutionLogReference,
} from '../session/execution-log.js';
import type { SessionEvent } from '../session/format.js';
import { checkedCheckDeclaration, checkedCheckScopeSamples, type CheckDeclaration, type CheckScopeSample } from '../session/checks.js';

const MAX_ACTIVE_PER_RUN = 4;
const MAX_ACTIVE_PER_SESSION = 8;
const MAX_ACTIVE_PER_HOST = 32;
const MAX_RETAINED_TERMINAL = 128;
const MAX_WAITERS_PER_COMMAND = 2;
const MAX_WAIT_MS = 30_000;
const MAX_PAGE_BYTES = 4 * 1024;
const MAX_PAGE_EVENTS = 64;
const MAX_SESSION_LOG_FILE_BYTES = 16 * 1024 * 1024;
const MAX_HOST_LOG_FILE_BYTES = 128 * 1024 * 1024;

export type FiniteCommandState = 'starting' | 'running' | 'stopping' | 'exited' | 'cancelled' | 'failed' | 'unknown';
export type FiniteCommandStopReason = 'user_cancel' | 'run_cancel' | 'run_failed' | 'session_close'
  | 'host_close' | 'workspace_revoked' | 'grant_revoked' | 'timeout' | 'record_failed';

export interface FiniteCommandOwner {
  readonly projectIdentity: string;
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly parentRunId?: string;
  readonly grantId?: string;
  readonly workspaceTrusted: boolean;
  readonly check?: CheckDeclaration;
  readonly checkScopeStart?: readonly CheckScopeSample[];
}

export interface FiniteCommandSession {
  readonly directory: string;
  append(event: Record<string, unknown>): Promise<unknown>;
}

export interface FiniteCommandReservation {
  readonly executionId: string;
}

interface Entry {
  readonly executionId: string;
  readonly cursorGeneration: string;
  readonly owner: FiniteCommandOwner;
  readonly append: FiniteCommandSession['append'];
  readonly sessionDirectory: string;
  readonly timeoutMs: number;
  readonly acceptedAt: string;
  readonly work?: TaskWork;
  readonly ready: Promise<void>;
  readonly readyResolve: () => void;
  state: FiniteCommandState;
  lease?: ManagedExecLease;
  accepted: boolean;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  errorCode?: string;
  cancelRequested: boolean;
  deadlineExceeded: boolean;
  terminationPending: boolean;
  cleanupPending: boolean;
  terminationReason?: FiniteCommandStopReason;
  waiters: number;
  stopTask?: Promise<void>;
  settled?: Promise<void>;
  onAbort?: () => void;
  signal?: AbortSignal;
  timeout?: ReturnType<typeof setTimeout>;
  terminalOrder?: number;
  recordFailure?: boolean;
  logRef?: ExecutionLogReference;
  persistedLogs?: ExecLogSnapshot;
  logUnavailableReason?: string;
  persistedFileBytes: number;
  logTotalBytes?: number;
  logFirstAvailableOffset?: number;
}

export interface FiniteCommandView extends Record<string, unknown> {
  readonly executionId: string;
  readonly projectIdentity: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly parentRunId?: string;
  readonly state: FiniteCommandState;
  readonly acceptedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly deadlineAt?: string;
  readonly timeoutMs: number;
  readonly exitCode?: number;
  readonly errorCode?: string;
  readonly cancelRequested: boolean;
  readonly deadlineExceeded: boolean;
  readonly terminationPending: boolean;
  readonly cleanupPending: boolean;
  readonly recordFailure: boolean;
  readonly logAvailable: boolean;
  readonly logUnavailableReason?: string;
}

export interface FiniteCommandRegistry {
  restoreSession(input: {
    readonly sessionId: string;
    readonly projectIdentity: string;
    readonly projectRoot: string;
    readonly session: FiniteCommandSession;
    readonly events: readonly SessionEvent[];
  }): Promise<void>;
  accountDirectory(directory: string): Promise<void>;
  reserve(input: {
    readonly owner: FiniteCommandOwner;
    readonly session: FiniteCommandSession;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly startWork?: () => TaskWork | undefined;
  }): Promise<FiniteCommandReservation>;
  attach(reservation: FiniteCommandReservation, lease: ManagedExecLease, signal: AbortSignal | undefined, waitMs: number): Promise<Record<string, unknown>>;
  failReservation(reservation: FiniteCommandReservation, error: unknown): Promise<void>;
  status(owner: Pick<FiniteCommandOwner, 'projectIdentity' | 'sessionId' | 'runId'>, executionId: string): FiniteCommandView;
  wait(owner: Pick<FiniteCommandOwner, 'projectIdentity' | 'sessionId' | 'runId'>, executionId: string, waitMs: number, signal?: AbortSignal): Promise<Record<string, unknown>>;
  logs(owner: Pick<FiniteCommandOwner, 'projectIdentity' | 'sessionId' | 'runId'>, executionId: string, cursor?: string, limitBytes?: number): Record<string, unknown>;
  cancel(owner: Pick<FiniteCommandOwner, 'projectIdentity' | 'sessionId' | 'runId'>, executionId: string): Promise<Record<string, unknown>>;
  beginCompletionCandidate(sessionId: string, runId: string): void;
  resumeRun(sessionId: string, runId: string): void;
  settleRun(sessionId: string, runId: string, reason: 'completed' | 'cancelled' | 'failed'): Promise<void>;
  finishRun(sessionId: string, runId: string): Promise<void>;
  stopRun(sessionId: string, runId: string, reason?: FiniteCommandStopReason): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  stopProject(projectIdentity: string): Promise<void>;
  stopGrant(grantId: string): Promise<void>;
  close(): Promise<void>;
}

export interface FiniteCommandRegistryOptions {
  readonly validateOwner?: (owner: FiniteCommandOwner) => Promise<void>;
  readonly onTerminal?: (entry: {
    readonly executionId: string;
    readonly owner: FiniteCommandOwner;
    readonly state: FiniteCommandState;
    readonly exitCode?: number;
    readonly errorCode?: string;
    readonly logs?: ExecLogSnapshot;
    readonly logUnavailableReason?: string;
  }) => Promise<void>;
}

function runKey(sessionId: string, runId: string): string {
  return `${sessionId}\0${runId}`;
}

function directoryKey(directory: string): string {
  const path = resolve(directory);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function isActive(entry: Entry): boolean {
  if (entry.state === 'unknown') return false;
  return entry.state === 'starting' || entry.state === 'running' || entry.state === 'stopping'
    || entry.terminationPending || entry.cleanupPending;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}

function pendingState(error: unknown): { terminationPending: boolean; cleanupPending: boolean } {
  switch (codeOf(error)) {
    case 'exec_termination_cleanup_failed':
      return { terminationPending: true, cleanupPending: true };
    case 'exec_sandbox_cleanup_failed':
    case 'exec_guardian_failed':
    case 'exec_guardian_protocol':
    case 'exec_terminate_failed':
      return { terminationPending: true, cleanupPending: codeOf(error) === 'exec_sandbox_cleanup_failed' };
    case 'exec_temp_cleanup_failed':
    case 'exec_script_snapshot_cleanup_failed':
      return { terminationPending: false, cleanupPending: true };
    default:
      return { terminationPending: false, cleanupPending: false };
  }
}

function cursorOf(entry: Entry, offset: number): string {
  return Buffer.from(JSON.stringify({ executionId: entry.executionId, generation: entry.cursorGeneration, offset }), 'utf8')
    .toString('base64url');
}

function offsetOf(entry: Entry, cursor: string | undefined, totalBytes: number): number {
  if (cursor === undefined) return 0;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch { throw new KernelError('execution_cursor_invalid'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new KernelError('execution_cursor_invalid');
  const decoded = value as Record<string, unknown>;
  if (decoded.executionId !== entry.executionId || decoded.generation !== entry.cursorGeneration
    || !Number.isSafeInteger(decoded.offset) || Number(decoded.offset) < 0 || Number(decoded.offset) > totalBytes) {
    throw new KernelError('execution_cursor_invalid');
  }
  return decoded.offset as number;
}

function readLeaseLogs(lease: ManagedExecLease | undefined, offset: number, limitBytes: number): ExecLogSnapshot {
  return lease?.readLogs?.(offset, limitBytes) ?? { totalBytes: 0, firstAvailableOffset: 0, chunks: [] };
}

function sliceSnapshot(snapshot: ExecLogSnapshot, offset: number, limitBytes: number): ExecLogSnapshot {
  let nextOffset = Math.max(offset, snapshot.firstAvailableOffset);
  let remaining = Math.max(1, Math.min(MAX_PAGE_BYTES, limitBytes));
  const chunks: ExecLogSnapshot['chunks'][number][] = [];
  for (const item of snapshot.chunks) {
    const itemEnd = item.offset + item.data.length;
    if (itemEnd <= nextOffset) continue;
    const start = Math.max(0, nextOffset - item.offset);
    const length = Math.min(item.data.length - start, remaining);
    if (length <= 0) break;
    chunks.push({ sequence: item.sequence, stream: item.stream, offset: item.offset + start,
      data: item.data.subarray(start, start + length) });
    nextOffset += length;
    remaining -= length;
    if (remaining === 0) break;
  }
  return { totalBytes: snapshot.totalBytes, firstAvailableOffset: snapshot.firstAvailableOffset, chunks };
}

function logPage(entry: Entry, cursor: string | undefined, limitBytes: number): Record<string, unknown> {
  const stored = entry.persistedLogs;
  const totalBytes = (entry.lease === undefined ? undefined : readLeaseLogs(entry.lease, 0, 1).totalBytes)
    ?? stored?.totalBytes ?? entry.logTotalBytes ?? 0;
  const unavailableReason = entry.lease !== undefined || stored !== undefined ? undefined : entry.logUnavailableReason
    ?? (entry.lease === undefined && stored === undefined && totalBytes > 0 ? 'payload_missing' : undefined);
  const retained = entry.lease === undefined ? stored : undefined;
  const firstAvailableOffset = (entry.lease === undefined ? undefined : readLeaseLogs(entry.lease, 0, 1).firstAvailableOffset)
    ?? retained?.firstAvailableOffset
    ?? (unavailableReason === undefined ? entry.logFirstAvailableOffset ?? totalBytes : totalBytes);
  const offset = offsetOf(entry, cursor, totalBytes);
  const snapshot = entry.lease !== undefined
    ? readLeaseLogs(entry.lease, offset, limitBytes)
    : retained !== undefined
      ? sliceSnapshot(retained, offset, limitBytes)
      : { totalBytes, firstAvailableOffset, chunks: [] };
  const gap = offset < snapshot.firstAvailableOffset;
  let nextOffset = Math.max(offset, snapshot.firstAvailableOffset);
  const events = snapshot.chunks.slice(0, MAX_PAGE_EVENTS).map((chunk) => {
    const text = decode(chunk.data);
    const end = chunk.offset + chunk.data.length;
    nextOffset = Math.max(nextOffset, end);
    return {
      sequence: chunk.sequence,
      stream: chunk.stream,
      offset: chunk.offset,
      byteLength: chunk.data.length,
      text,
      dataBase64: chunk.data.toString('base64'),
      decodeLossPossible: text.includes('\uFFFD'),
    };
  });
  return {
    executionId: entry.executionId,
    events,
    available: unavailableReason === undefined,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    cursor: cursor ?? cursorOf(entry, 0),
    firstAvailableCursor: cursorOf(entry, snapshot.firstAvailableOffset),
    nextCursor: cursorOf(entry, nextOffset),
    hasMore: nextOffset < snapshot.totalBytes,
    gap,
    ...(gap ? { missingRange: { fromOffset: offset, toOffset: snapshot.firstAvailableOffset } } : {}),
    terminal: !isActive(entry),
    truncated: snapshot.firstAvailableOffset > 0,
    totalBytes: snapshot.totalBytes,
    firstAvailableOffset: snapshot.firstAvailableOffset,
    nextOffset,
  };
}

function view(entry: Entry): FiniteCommandView {
  return {
    executionId: entry.executionId,
    projectIdentity: entry.owner.projectIdentity,
    sessionId: entry.owner.sessionId,
    runId: entry.owner.runId,
    callId: entry.owner.callId,
    ...(entry.owner.parentRunId === undefined ? {} : { parentRunId: entry.owner.parentRunId }),
    state: entry.state,
    acceptedAt: entry.acceptedAt,
    ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
    ...(entry.finishedAt === undefined ? {} : { finishedAt: entry.finishedAt }),
    ...(entry.startedAt === undefined ? {} : { deadlineAt: new Date(Date.parse(entry.startedAt) + entry.timeoutMs).toISOString() }),
    timeoutMs: entry.timeoutMs,
    ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
    ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
    cancelRequested: entry.cancelRequested,
    deadlineExceeded: entry.deadlineExceeded,
    terminationPending: entry.terminationPending,
    cleanupPending: entry.cleanupPending,
    recordFailure: entry.recordFailure === true,
    logTotalBytes: entry.logTotalBytes ?? 0,
    logFirstAvailableOffset: entry.logFirstAvailableOffset ?? 0,
    logAvailable: entry.lease !== undefined || entry.persistedLogs !== undefined
      || (entry.logUnavailableReason === undefined && (entry.logTotalBytes ?? 0) === 0),
    ...(entry.logUnavailableReason === undefined ? {} : { logUnavailableReason: entry.logUnavailableReason }),
  };
}

export function createFiniteCommandRegistry(options: FiniteCommandRegistryOptions = {}): FiniteCommandRegistry {
  const entries = new Map<string, Entry>();
  const completionCandidates = new Set<string>();
  const finishedRuns = new Set<string>();
  const sessionLogFileBytes = new Map<string, number>();
  const directoryLogFileBytes = new Map<string, number>();
  const directoryScans = new Map<string, Promise<void>>();
  let closed = false;
  let nextTerminalOrder = 0;
  let hostLogFileBytes = 0;
  let hostLogQuotaExceeded = false;
  let ownerCheck: ReturnType<typeof setInterval> | undefined;
  let checkingOwner = false;
  const restoredSessions = new Set<string>();

  const activeEntries = () => [...entries.values()].filter(isActive);

  async function accountDirectoryFiles(directory: string): Promise<void> {
    const key = directoryKey(directory);
    const existing = directoryScans.get(key);
    if (existing !== undefined) return await existing;
    const scanTask = (async () => {
      const scan = await scanExecutionLogs(directory, MAX_HOST_LOG_FILE_BYTES);
      directoryLogFileBytes.set(key, scan.bytes);
      if (!scan.complete || hostLogFileBytes + scan.bytes > MAX_HOST_LOG_FILE_BYTES) {
        hostLogFileBytes = MAX_HOST_LOG_FILE_BYTES;
        hostLogQuotaExceeded = true;
      } else hostLogFileBytes += scan.bytes;
    })();
    directoryScans.set(key, scanTask);
    try { await scanTask; }
    catch (error) {
      if (directoryScans.get(key) === scanTask) directoryScans.delete(key);
      throw error;
    }
  }

  function removeRunMarkersIfUnused(sessionId: string, runId: string): void {
    if ([...entries.values()].some((entry) => entry.owner.sessionId === sessionId && entry.owner.runId === runId)) return;
    completionCandidates.delete(runKey(sessionId, runId));
    finishedRuns.delete(runKey(sessionId, runId));
  }

  function pruneTerminal(): void {
    const terminal = [...entries.values()].filter((entry) => !isActive(entry));
    for (const entry of terminal) entry.terminalOrder ??= nextTerminalOrder++;
    terminal.sort((left, right) => (left.terminalOrder ?? 0) - (right.terminalOrder ?? 0));
    while (terminal.length > MAX_RETAINED_TERMINAL) {
      const removed = terminal.shift();
      if (removed === undefined) break;
      entries.delete(removed.executionId);
      if (removed.logRef !== undefined) {
        const name = removed.logRef.name;
        const sessionId = removed.owner.sessionId;
        const directory = directoryKey(removed.sessionDirectory);
        const bytes = removed.persistedFileBytes;
        void removeExecutionLog(removed.sessionDirectory, name).then((removedFile) => {
          if (!removedFile) return;
          hostLogFileBytes = Math.max(0, hostLogFileBytes - bytes);
          directoryLogFileBytes.set(directory, Math.max(0, (directoryLogFileBytes.get(directory) ?? 0) - bytes));
          const sessionBytes = Math.max(0, (sessionLogFileBytes.get(sessionId) ?? 0) - bytes);
          if (sessionBytes === 0 && ![...entries.values()].some((entry) => entry.owner.sessionId === sessionId)) {
            sessionLogFileBytes.delete(sessionId);
            restoredSessions.delete(sessionId);
          } else sessionLogFileBytes.set(sessionId, sessionBytes);
        }).catch(() => undefined);
        delete removed.logRef;
        delete removed.persistedLogs;
        removed.persistedFileBytes = 0;
      }
      removeRunMarkersIfUnused(removed.owner.sessionId, removed.owner.runId);
      if (![...entries.values()].some((entry) => entry.owner.sessionId === removed.owner.sessionId)) {
        if ((sessionLogFileBytes.get(removed.owner.sessionId) ?? 0) === 0) {
          restoredSessions.delete(removed.owner.sessionId);
          sessionLogFileBytes.delete(removed.owner.sessionId);
        }
      }
    }
  }

  function findOwned(owner: Pick<FiniteCommandOwner, 'projectIdentity' | 'sessionId' | 'runId'>, executionId: string): Entry {
    const entry = entries.get(executionId);
    if (entry === undefined || entry.owner.projectIdentity !== owner.projectIdentity
      || entry.owner.sessionId !== owner.sessionId || entry.owner.runId !== owner.runId) {
      throw new KernelError('execution_not_found');
    }
    return entry;
  }

  async function persist(entry: Entry, state: string): Promise<void> {
    try {
      await entry.append({
        kind: 'execution', ignorable: true, state,
        executionId: entry.executionId,
        cursorGeneration: entry.cursorGeneration,
        projectIdentity: entry.owner.projectIdentity,
        sessionId: entry.owner.sessionId,
        runId: entry.owner.runId,
        callId: entry.owner.callId,
        ...(entry.owner.parentRunId === undefined ? {} : { parentRunId: entry.owner.parentRunId }),
        ...(entry.owner.check === undefined ? {} : { check: entry.owner.check }),
        ...(entry.owner.checkScopeStart === undefined ? {} : { checkScopeStart: entry.owner.checkScopeStart }),
        ...(entry.startedAt === undefined ? { acceptedAt: entry.acceptedAt } : { startedAt: entry.startedAt }),
        ...(entry.finishedAt === undefined ? {} : { finishedAt: entry.finishedAt }),
        timeoutMs: entry.timeoutMs,
        ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
        ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
        cancelRequested: entry.cancelRequested,
        deadlineExceeded: entry.deadlineExceeded,
        terminationPending: entry.terminationPending,
        cleanupPending: entry.cleanupPending,
        logTotalBytes: entry.logTotalBytes ?? 0,
        logFirstAvailableOffset: entry.logFirstAvailableOffset ?? 0,
        ...(entry.logRef === undefined ? {} : { logsRef: entry.logRef }),
        ...(entry.logUnavailableReason === undefined ? {} : { logUnavailableReason: entry.logUnavailableReason }),
        ...(entry.recordFailure === true ? { recordFailure: true } : {}),
      });
    } catch (cause) {
      entry.recordFailure = true;
      throw new KernelError('execution_record_failed', { cause });
    }
  }

  async function finalize(entry: Entry, outcome: { readonly exitCode?: number; readonly error?: unknown }): Promise<void> {
    if (entry.timeout !== undefined) clearTimeout(entry.timeout);
    entry.timeout = undefined;
    if (entry.onAbort !== undefined && entry.signal !== undefined) entry.signal.removeEventListener('abort', entry.onAbort);
    entry.onAbort = undefined;
    entry.signal = undefined;
    const code = codeOf(outcome.error);
    const pending = pendingState(outcome.error);
    entry.terminationPending = pending.terminationPending;
    entry.cleanupPending = pending.cleanupPending;
    entry.exitCode = outcome.exitCode;
    entry.finishedAt = new Date().toISOString();
    if (entry.lease !== undefined) {
      const snapshot = readLeaseLogs(entry.lease, 0, MAX_EXECUTION_LOG_RAW_BYTES);
      const fileBytes = executionLogEncodedBytes(entry.executionId, snapshot);
      entry.logTotalBytes = snapshot.totalBytes;
      entry.logFirstAvailableOffset = snapshot.firstAvailableOffset;
      entry.persistedLogs = snapshot;
      if (fileBytes > 0 && snapshot.totalBytes > 0) {
        const sessionBytes = sessionLogFileBytes.get(entry.owner.sessionId) ?? 0;
        const directory = directoryKey(entry.sessionDirectory);
        const directoryBytes = directoryLogFileBytes.get(directory) ?? 0;
        if (sessionBytes + fileBytes > MAX_SESSION_LOG_FILE_BYTES || hostLogQuotaExceeded
          || hostLogFileBytes + fileBytes > MAX_HOST_LOG_FILE_BYTES) {
          entry.logUnavailableReason = 'storage_quota_exceeded';
        } else {
          try {
            entry.logRef = await writeExecutionLog(entry.sessionDirectory, entry.executionId, snapshot);
            entry.persistedFileBytes = entry.logRef.bytes;
            sessionLogFileBytes.set(entry.owner.sessionId, sessionBytes + entry.logRef.bytes);
            directoryLogFileBytes.set(directory, directoryBytes + entry.logRef.bytes);
            hostLogFileBytes += entry.logRef.bytes;
            delete entry.logUnavailableReason;
          } catch {
            entry.logUnavailableReason = 'payload_write_failed';
          }
        }
      }
    }
    if (entry.terminationReason === 'timeout') {
      entry.deadlineExceeded = true;
      entry.errorCode = 'exec_timeout';
      entry.state = 'failed';
    } else if (entry.terminationReason !== undefined && entry.terminationReason !== 'record_failed') {
      entry.cancelRequested = true;
      entry.errorCode = code ?? 'exec_cancelled';
      entry.state = pending.terminationPending || pending.cleanupPending ? 'failed' : 'cancelled';
    } else if (outcome.error !== undefined) {
      entry.errorCode = code ?? 'exec_failed';
      entry.state = code === 'exec_cancelled' ? 'cancelled' : 'failed';
    } else {
      entry.state = 'exited';
    }
    let terminalRecorded = false;
    try {
      await persist(entry, entry.state);
      terminalRecorded = true;
    } catch (error) {
      entry.recordFailure = true;
      entry.errorCode = codeOf(error) ?? 'execution_record_failed';
      entry.state = 'failed';
      if (entry.logRef !== undefined) {
        const removedFile = await removeExecutionLog(entry.sessionDirectory, entry.logRef.name).catch(() => false);
        if (removedFile) {
          const directory = directoryKey(entry.sessionDirectory);
          hostLogFileBytes = Math.max(0, hostLogFileBytes - entry.persistedFileBytes);
          directoryLogFileBytes.set(directory, Math.max(0, (directoryLogFileBytes.get(directory) ?? 0) - entry.persistedFileBytes));
          sessionLogFileBytes.set(entry.owner.sessionId,
            Math.max(0, (sessionLogFileBytes.get(entry.owner.sessionId) ?? 0) - entry.persistedFileBytes));
          delete entry.logRef;
          entry.persistedFileBytes = 0;
          entry.logUnavailableReason = 'session_record_failed';
        }
      }
      throw error;
    } finally {
      if (terminalRecorded && options.onTerminal !== undefined && entry.owner.check !== undefined) {
        await options.onTerminal({ executionId: entry.executionId, owner: entry.owner, state: entry.state,
          ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
          ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
          ...(entry.persistedLogs === undefined ? {} : { logs: entry.persistedLogs }),
          ...(entry.logUnavailableReason === undefined ? {} : { logUnavailableReason: entry.logUnavailableReason }),
        }).catch(() => undefined);
      }
      if (!entry.terminationPending && !entry.cleanupPending) entry.work?.dispose();
      pruneTerminal();
    }
  }

  async function waitUntil(entry: Entry, waitMs: number, signal?: AbortSignal): Promise<boolean> {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) {
      throw new KernelError('execution_wait_invalid');
    }
    if (!isActive(entry)) return true;
    if (waitMs === 0) return false;
    if (entry.waiters >= MAX_WAITERS_PER_COMMAND) throw new KernelError('execution_waiter_limit');
    entry.waiters += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) throw new KernelError('loop_cancelled');
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
        timer.unref?.();
      });
      const settled = entry.settled?.then(() => true, () => true) ?? Promise.resolve(!isActive(entry));
      const aborted = signal === undefined ? new Promise<never>(() => {}) : new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new KernelError('loop_cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([settled, timeout, aborted]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
      entry.waiters -= 1;
    }
  }

  function viewWithWait(entry: Entry, waitTimedOut: boolean): Record<string, unknown> {
    return { ...view(entry), waitTimedOut };
  }

  async function requestStop(entry: Entry, reason: FiniteCommandStopReason): Promise<void> {
    if (!isActive(entry)) return;
    entry.terminationReason ??= reason;
    if (reason !== 'timeout' && reason !== 'record_failed') entry.cancelRequested = true;
    if (reason === 'timeout') entry.deadlineExceeded = true;
    entry.state = 'stopping';
    if (entry.timeout !== undefined) clearTimeout(entry.timeout);
    entry.timeout = undefined;
    if (entry.lease === undefined) {
      entry.terminationPending = true;
      return;
    }
    if (entry.stopTask !== undefined) return await entry.stopTask;
    let task!: Promise<void>;
    task = (async () => {
      try {
        await entry.lease!.stop();
        await entry.settled?.catch(() => undefined);
        if (entry.terminationPending || entry.cleanupPending) {
          entry.terminationPending = false;
          entry.cleanupPending = false;
          if (entry.terminationReason === 'timeout') {
            entry.deadlineExceeded = true;
            entry.errorCode = 'exec_timeout';
            entry.state = 'failed';
          } else if (entry.errorCode !== undefined && entry.errorCode !== 'exec_cancelled') {
            entry.state = 'failed';
          } else if (entry.cancelRequested || entry.terminationReason !== undefined) {
            entry.errorCode ??= 'exec_cancelled';
            entry.state = 'cancelled';
          } else {
            entry.state = entry.exitCode === undefined ? 'failed' : 'exited';
          }
          await persist(entry, entry.state);
          entry.work?.dispose();
          pruneTerminal();
        }
      } catch (error) {
        const pending = pendingState(error);
        entry.terminationPending = pending.terminationPending;
        entry.cleanupPending = pending.cleanupPending;
        entry.errorCode = codeOf(error) ?? 'exec_terminate_failed';
        entry.finishedAt = new Date().toISOString();
        entry.state = 'failed';
        try { await persist(entry, entry.state); }
        catch { /* The primary failure remains queryable in Host memory. */ }
        if (!entry.terminationPending && !entry.cleanupPending) entry.work?.dispose();
        pruneTerminal();
      }
    })().finally(() => { if (entry.stopTask === task) entry.stopTask = undefined; });
    entry.stopTask = task;
    await task;
  }

  async function stopEntries(selected: readonly Entry[], reason: FiniteCommandStopReason): Promise<void> {
    let outcomes = await Promise.allSettled(selected.map((entry) => requestStop(entry, reason)));
    const failed = outcomes.find((item) => item.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const starting = selected.filter((entry) => entry.lease === undefined && isActive(entry));
    if (starting.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(starting.map((entry) => entry.ready)),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new KernelError('execution_start_settle_timeout')), 5_000);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      outcomes = await Promise.allSettled(starting.map((entry) => requestStop(entry, reason)));
      const retryFailure = outcomes.find((item) => item.status === 'rejected');
      if (retryFailure?.status === 'rejected') throw retryFailure.reason;
    }
    if (selected.some(isActive)) throw new KernelError('execution_cleanup_pending');
  }

  function startOwnerChecks(): void {
    if (ownerCheck !== undefined || options.validateOwner === undefined) return;
    ownerCheck = setInterval(() => {
      if (checkingOwner || closed) return;
      const active = activeEntries();
      if (active.length === 0) return;
      checkingOwner = true;
      void Promise.all(active.map(async (entry) => {
        try { await options.validateOwner!(entry.owner); }
        catch {
          await requestStop(entry, entry.owner.grantId === undefined ? 'workspace_revoked' : 'grant_revoked');
        }
      })).finally(() => { checkingOwner = false; });
    }, 1_000);
    ownerCheck.unref();
  }

  return {
    async accountDirectory(directory) {
      await accountDirectoryFiles(directory);
    },
    async restoreSession({ sessionId, projectIdentity, projectRoot, session, events }) {
      if (restoredSessions.has(sessionId)) return;
      await accountDirectoryFiles(session.directory);
      const latest = new Map<string, SessionEvent>();
      for (const event of events) {
        if (event.kind !== 'execution' || typeof event.executionId !== 'string' || event.sessionId !== sessionId) continue;
        latest.set(event.executionId, event);
      }
      if (latest.size === 0) return;
      restoredSessions.add(sessionId);
      sessionLogFileBytes.set(sessionId, sessionLogFileBytes.get(sessionId) ?? 0);
      for (const event of latest.values()) {
        if (event.projectIdentity !== projectIdentity || typeof event.runId !== 'string' || typeof event.callId !== 'string') {
          throw new KernelError('execution_owner_mismatch');
        }
        const executionId = event.executionId as string;
        if (entries.has(executionId)) continue;
        const recordedState = event.state;
        const terminal = recordedState === 'exited' || recordedState === 'cancelled' || recordedState === 'failed';
        const state: FiniteCommandState = terminal ? recordedState : 'unknown';
        const owner: FiniteCommandOwner = {
          projectIdentity, projectRoot, sessionId, runId: event.runId, callId: event.callId,
          ...(typeof event.parentRunId === 'string' ? { parentRunId: event.parentRunId } : {}),
          workspaceTrusted: false,
          ...(checkedCheckDeclaration(event.check) === undefined ? {} : { check: checkedCheckDeclaration(event.check)! }),
          ...(checkedCheckDeclaration(event.check) === undefined
            || checkedCheckScopeSamples(event.checkScopeStart, checkedCheckDeclaration(event.check)!) === undefined ? {} : {
              checkScopeStart: checkedCheckScopeSamples(event.checkScopeStart, checkedCheckDeclaration(event.check)!)!,
            }),
        };
        const cursorGeneration = typeof event.cursorGeneration === 'string' ? event.cursorGeneration : randomUUID();
        const logTotalBytes = Number.isSafeInteger(event.logTotalBytes) && Number(event.logTotalBytes) >= 0
          ? Number(event.logTotalBytes) : 0;
        const logFirstAvailableOffset = Number.isSafeInteger(event.logFirstAvailableOffset) && Number(event.logFirstAvailableOffset) >= 0
          ? Number(event.logFirstAvailableOffset) : 0;
        const rawRef = event.logsRef;
        const logRef = typeof rawRef === 'object' && rawRef !== null && !Array.isArray(rawRef)
          ? rawRef as unknown as ExecutionLogReference : undefined;
        const entry: Entry = {
          executionId, cursorGeneration, owner, append: session.append.bind(session), sessionDirectory: session.directory,
          timeoutMs: Number.isSafeInteger(event.timeoutMs) ? Number(event.timeoutMs) : 120_000,
          acceptedAt: typeof event.acceptedAt === 'string' ? event.acceptedAt : typeof event.startedAt === 'string' ? event.startedAt : new Date(0).toISOString(),
          ready: Promise.resolve(), readyResolve: () => {},
          state,
          accepted: true,
          ...(typeof event.startedAt === 'string' ? { startedAt: event.startedAt } : {}),
          ...(typeof event.finishedAt === 'string' ? { finishedAt: event.finishedAt } : {}),
          ...(Number.isSafeInteger(event.exitCode) ? { exitCode: Number(event.exitCode) } : {}),
          ...(typeof event.errorCode === 'string' ? { errorCode: event.errorCode } : {}),
          cancelRequested: event.cancelRequested === true,
          deadlineExceeded: event.deadlineExceeded === true,
          terminationPending: !terminal || event.terminationPending === true,
          cleanupPending: !terminal || event.cleanupPending === true,
          waiters: 0,
          persistedFileBytes: 0,
          logTotalBytes,
          logFirstAvailableOffset,
          ...(logRef === undefined ? {} : { logRef }),
          ...(typeof event.logUnavailableReason === 'string' ? { logUnavailableReason: event.logUnavailableReason }
            : !terminal ? { logUnavailableReason: 'host_interrupted' } : {}),
          ...(!terminal ? { errorCode: 'execution_result_unknown' } : {}),
          ...(event.recordFailure === true ? { recordFailure: true } : {}),
        };
        if (logRef !== undefined && terminal) {
          entry.persistedFileBytes = logRef.bytes;
          const sessionBytes = sessionLogFileBytes.get(sessionId) ?? 0;
          if (sessionBytes + logRef.bytes > MAX_SESSION_LOG_FILE_BYTES) {
            entry.logUnavailableReason = 'storage_quota_exceeded';
            sessionLogFileBytes.set(sessionId, MAX_SESSION_LOG_FILE_BYTES);
            delete entry.logRef;
            entry.persistedFileBytes = 0;
          } else {
            sessionLogFileBytes.set(sessionId, sessionBytes + logRef.bytes);
            try {
              const snapshot = await readExecutionLog(session.directory, executionId, logRef);
              entry.persistedLogs = snapshot;
              if (entry.logUnavailableReason === 'payload_missing_or_invalid') delete entry.logUnavailableReason;
            } catch {
              entry.logUnavailableReason = 'payload_missing_or_invalid';
              delete entry.logRef;
              entry.persistedFileBytes = 0;
            }
          }
        } else if (logTotalBytes > 0 && entry.logUnavailableReason === undefined) {
          entry.logUnavailableReason = 'payload_missing';
        }
        entry.terminalOrder = nextTerminalOrder++;
        entries.set(executionId, entry);
        if (!terminal) entry.errorCode = 'execution_result_unknown';
        pruneTerminal();
      }
    },
    async reserve({ owner, session, timeoutMs, signal, startWork }) {
      if (closed) throw new KernelError('execution_registry_closed');
      if (signal?.aborted) throw new KernelError('loop_cancelled');
      restoredSessions.add(owner.sessionId);
      sessionLogFileBytes.set(owner.sessionId, sessionLogFileBytes.get(owner.sessionId) ?? 0);
      if (options.validateOwner !== undefined) await options.validateOwner(owner);
      const key = runKey(owner.sessionId, owner.runId);
      if (completionCandidates.has(key) || finishedRuns.has(key)) throw new KernelError('execution_run_not_accepting');
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new KernelError('exec_timeout_invalid');
      const active = activeEntries();
      if (active.length >= MAX_ACTIVE_PER_HOST) throw new KernelError('execution_host_limit');
      if (active.filter((entry) => entry.owner.sessionId === owner.sessionId).length >= MAX_ACTIVE_PER_SESSION) {
        throw new KernelError('execution_session_limit');
      }
      if (active.filter((entry) => entry.owner.sessionId === owner.sessionId && entry.owner.runId === owner.runId).length >= MAX_ACTIVE_PER_RUN) {
        throw new KernelError('execution_run_limit');
      }
      const work = startWork?.();
      let readyResolve!: () => void;
      const ready = new Promise<void>((resolveReady) => { readyResolve = resolveReady; });
      const entry: Entry = {
        executionId: randomUUID(), cursorGeneration: randomUUID(), owner, append: session.append.bind(session),
        sessionDirectory: session.directory,
        timeoutMs, acceptedAt: new Date().toISOString(), ready, readyResolve, persistedFileBytes: 0,
        ...(work === undefined ? {} : { work }),
        state: 'starting', accepted: false, cancelRequested: false, deadlineExceeded: false,
        terminationPending: false, cleanupPending: false, waiters: 0,
      };
      entries.set(entry.executionId, entry);
      try {
        await persist(entry, 'accepted');
        entry.accepted = true;
      } catch (error) {
        entry.readyResolve();
        entries.delete(entry.executionId);
        work?.dispose();
        throw error;
      }
      startOwnerChecks();
      return { executionId: entry.executionId };
    },
    async attach(reservation, lease, signal, waitMs) {
      const entry = entries.get(reservation.executionId);
      if (entry === undefined || !entry.accepted || entry.state !== 'starting') throw new KernelError('execution_reservation_invalid');
      entry.lease = lease;
      entry.state = entry.terminationReason === undefined ? 'running' : 'stopping';
      entry.startedAt = new Date().toISOString();
      entry.readyResolve();
      entry.signal = signal;
      const onAbort = () => { void requestStop(entry, 'run_cancel'); };
      entry.onAbort = onAbort;
      if (signal?.aborted) void requestStop(entry, 'run_cancel');
      else if (entry.terminationReason !== undefined) void requestStop(entry, entry.terminationReason);
      else signal?.addEventListener('abort', onAbort, { once: true });
      let settled!: Promise<void>;
      settled = lease.completion.then(
        async (exitCode) => await finalize(entry, { exitCode }),
        async (error: unknown) => await finalize(entry, { error }),
      ).finally(() => { if (entry.settled === settled) entry.settled = settled; });
      entry.settled = settled;
      void settled.catch(() => undefined);
      entry.timeout = setTimeout(() => { void requestStop(entry, 'timeout'); }, entry.timeoutMs);
      entry.timeout.unref?.();
      try {
        await persist(entry, 'started');
      } catch (error) {
        await requestStop(entry, 'record_failed');
        throw error;
      }
      const completed = await waitUntil(entry, waitMs, signal);
      return {
        kind: 'execution',
        ...view(entry),
        waitTimedOut: !completed,
        logs: logPage(entry, undefined, MAX_PAGE_BYTES),
      };
    },
    async failReservation(reservation, error) {
      const entry = entries.get(reservation.executionId);
      if (entry === undefined || entry.lease !== undefined) return;
      entry.errorCode = codeOf(error) ?? 'exec_spawn_failed';
      const pending = pendingState(error);
      entry.terminationPending = pending.terminationPending;
      entry.cleanupPending = pending.cleanupPending;
      entry.state = entry.terminationReason !== undefined && !pending.terminationPending && !pending.cleanupPending
        ? 'cancelled' : 'failed';
      entry.finishedAt = new Date().toISOString();
      entry.readyResolve();
      let terminalRecorded = false;
      try {
        await persist(entry, entry.state);
        terminalRecorded = true;
      }
      finally {
        if (terminalRecorded && options.onTerminal !== undefined && entry.owner.check !== undefined) {
          await options.onTerminal({ executionId: entry.executionId, owner: entry.owner, state: entry.state,
            ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
          }).catch(() => undefined);
        }
        entry.work?.dispose();
        pruneTerminal();
      }
    },
    status(owner, executionId) {
      return view(findOwned(owner, executionId));
    },
    async wait(owner, executionId, waitMs, signal) {
      const entry = findOwned(owner, executionId);
      const completed = await waitUntil(entry, waitMs, signal);
      return viewWithWait(entry, !completed);
    },
    logs(owner, executionId, cursor, limitBytes = MAX_PAGE_BYTES) {
      if (!Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > MAX_PAGE_BYTES) {
        throw new KernelError('execution_log_page_limit');
      }
      const entry = findOwned(owner, executionId);
      return logPage(entry, cursor, limitBytes);
    },
    async cancel(owner, executionId) {
      const entry = findOwned(owner, executionId);
      await requestStop(entry, 'user_cancel');
      return { ...view(entry), cancelRequested: entry.cancelRequested };
    },
    beginCompletionCandidate(sessionId, runId) {
      completionCandidates.add(runKey(sessionId, runId));
    },
    resumeRun(sessionId, runId) {
      completionCandidates.delete(runKey(sessionId, runId));
      finishedRuns.delete(runKey(sessionId, runId));
    },
    async settleRun(sessionId, runId, reason) {
      const owned = [...entries.values()].filter((entry) => entry.owner.sessionId === sessionId && entry.owner.runId === runId && isActive(entry));
      if (reason === 'completed') {
        await Promise.all(owned.map((entry) => entry.settled?.catch((error) => { throw error; })));
        if (owned.some(isActive)) throw new KernelError('execution_cleanup_pending');
        return;
      }
      await stopEntries(owned, reason === 'cancelled' ? 'run_cancel' : 'run_failed');
    },
    async finishRun(sessionId, runId) {
      const key = runKey(sessionId, runId);
      completionCandidates.delete(key);
      finishedRuns.add(key);
      const owned = [...entries.values()].filter((entry) => entry.owner.sessionId === sessionId && entry.owner.runId === runId);
      if (owned.some(isActive)) await stopEntries(owned, 'run_failed');
      pruneTerminal();
    },
    async stopRun(sessionId, runId, reason = 'run_cancel') {
      await stopEntries([...entries.values()].filter((entry) => entry.owner.sessionId === sessionId && entry.owner.runId === runId), reason);
    },
    async stopSession(sessionId) {
      await stopEntries([...entries.values()].filter((entry) => entry.owner.sessionId === sessionId), 'session_close');
    },
    async stopProject(projectIdentity) {
      await stopEntries([...entries.values()].filter((entry) => entry.owner.projectIdentity === projectIdentity
        && entry.owner.workspaceTrusted), 'workspace_revoked');
    },
    async stopGrant(grantId) {
      await stopEntries([...entries.values()].filter((entry) => entry.owner.grantId === grantId), 'grant_revoked');
    },
    async close() {
      if (closed) return;
      closed = true;
      if (ownerCheck !== undefined) clearInterval(ownerCheck);
      await stopEntries([...entries.values()], 'host_close');
    },
  };
}

export const execControlTool = {
  name: 'exec_control',
  access: 'exec' as const,
  execution: 'serial' as const,
  description: 'Inspect, wait for, read bounded logs from, or cancel a finite command started by this Run. Waiting does not cancel the command.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['status', 'wait', 'logs', 'cancel'] },
      executionId: { type: 'string', minLength: 1, maxLength: 160 },
      waitMs: { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS },
      cursor: { type: 'string', minLength: 1, maxLength: 512 },
      limitBytes: { type: 'integer', minimum: 1, maximum: MAX_PAGE_BYTES },
    },
    required: ['action', 'executionId'],
  },
  preflight(value: unknown) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new KernelError('exec_control_args_invalid');
    const args = value as Record<string, unknown>;
    if (!['status', 'wait', 'logs', 'cancel'].includes(String(args.action))) throw new KernelError('exec_control_action_invalid');
    if (typeof args.executionId !== 'string' || args.executionId.trim() === '') throw new KernelError('exec_control_id_required');
    if (args.waitMs !== undefined && (!Number.isSafeInteger(args.waitMs) || Number(args.waitMs) < 0 || Number(args.waitMs) > MAX_WAIT_MS)) {
      throw new KernelError('execution_wait_invalid');
    }
    if (args.limitBytes !== undefined && (!Number.isSafeInteger(args.limitBytes) || Number(args.limitBytes) < 1
      || Number(args.limitBytes) > MAX_PAGE_BYTES)) throw new KernelError('execution_log_page_limit');
    if (args.cursor !== undefined && typeof args.cursor !== 'string') throw new KernelError('execution_cursor_invalid');
    if (args.action !== 'wait' && args.waitMs !== undefined) throw new KernelError('exec_control_args_invalid');
    if (args.action !== 'logs' && (args.cursor !== undefined || args.limitBytes !== undefined)) throw new KernelError('exec_control_args_invalid');
  },
  async run(value: unknown, context: import('../kernel/kernel.js').ToolContext) {
    if (context.execController === undefined) throw new KernelError('exec_control_unavailable');
    return await context.execController.control(value as ExecControlArguments, context);
  },
};
