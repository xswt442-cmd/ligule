import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { lstat, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { KernelError } from './error.js';
import { checkedOtlpEndpoint, createOtlpTraceSink } from './telemetry-otlp.js';

const MAX_RECORD_BYTES = 1024;
const MAX_QUEUE_RECORDS = 256;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_RETAINED_FILES = 4;
const MAX_MANIFEST_BYTES = 4096;
const MAX_TOTAL_BYTES = MAX_FILE_BYTES * MAX_RETAINED_FILES + MAX_MANIFEST_BYTES * 2;
const MAX_DIRECTORY_FILES = MAX_RETAINED_FILES + 2;
const LOCK_STALE_MS = 30_000;
const MANIFEST_TEMP_NAME = /^telemetry\.manifest\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;

export type TelemetryEvent =
  | { readonly type: 'run.started'; readonly executionId: string; readonly runId?: string; readonly sessionId?: string; readonly userSeq?: number; readonly parentExecutionId?: string; readonly parentRunId?: string; readonly parentCallId?: string }
  | { readonly type: 'run.finished'; readonly executionId: string; readonly runId?: string; readonly sessionId?: string; readonly userSeq?: number; readonly status: 'completed' | 'failed' | 'cancelled'; readonly durationMs: number; readonly modelCalls: number; readonly toolCalls: number; readonly errorCode?: string }
  | { readonly type: 'model.started'; readonly executionId: string; readonly runId?: string; readonly sessionId?: string; readonly userSeq?: number; readonly requestId: string; readonly logicalRequestId: string; readonly attempt: number; readonly provider?: string; readonly model?: string }
  | { readonly type: 'model.finished'; readonly executionId: string; readonly runId?: string; readonly sessionId?: string; readonly userSeq?: number; readonly requestId: string; readonly logicalRequestId: string; readonly attempt: number; readonly provider?: string; readonly model?: string; readonly durationMs: number; readonly status: 'completed' | 'failed' | 'cancelled'; readonly inputTokens?: number; readonly outputTokens?: number; readonly cacheSource?: 'chat-completions' | 'anthropic-messages'; readonly cacheSourceFields?: string; readonly cacheHitInputTokens?: number; readonly cacheMissInputTokens?: number; readonly cacheCreationInputTokens?: number; readonly cacheUncachedInputTokens?: number; readonly providerInputIncludesCache?: boolean; readonly cacheConsistent?: boolean; readonly finishReason?: 'stop' | 'tool_calls' | 'length' | 'max_tokens' | 'unknown'; readonly errorCode?: string }
  | { readonly type: 'tool.started'; readonly executionId: string; readonly runId?: string; readonly sessionId?: string; readonly userSeq?: number; readonly callId: string; readonly tool: string }
  | { readonly type: 'tool.finished'; readonly executionId: string; readonly runId?: string; readonly sessionId?: string; readonly userSeq?: number; readonly callId: string; readonly tool: string; readonly durationMs: number; readonly outcome: 'success' | 'failure' | 'refused' | 'cancelled'; readonly errorCode?: string }
  | { readonly type: 'approval.started'; readonly executionId: string; readonly runId?: string; readonly sessionId: string; readonly userSeq?: number; readonly parentExecutionId?: string; readonly parentRunId?: string; readonly parentCallId?: string; readonly callId?: string; readonly requestId: string }
  | { readonly type: 'approval.finished'; readonly executionId: string; readonly runId?: string; readonly sessionId: string; readonly userSeq?: number; readonly parentExecutionId?: string; readonly parentRunId?: string; readonly parentCallId?: string; readonly callId?: string; readonly requestId: string; readonly durationMs: number; readonly decision: 'allow' | 'deny' | 'cancelled' | 'error'; readonly errorCode?: string }
  | { readonly type: 'compaction.started'; readonly executionId: string; readonly runId?: string; readonly sessionId?: string; readonly userSeq?: number; readonly operationId: string; readonly operation: 'prepare' | 'recover' | 'explicit'; readonly inputMessages: number }
  | { readonly type: 'compaction.finished'; readonly executionId: string; readonly runId?: string; readonly sessionId?: string; readonly userSeq?: number; readonly operationId: string; readonly operation: 'prepare' | 'recover' | 'explicit'; readonly status: 'completed' | 'unchanged' | 'failed' | 'cancelled'; readonly durationMs: number; readonly inputMessages: number; readonly outputMessages?: number; readonly errorCode?: string };

export interface TelemetryOptions {
  readonly enabled?: boolean;
  /** Existing private directory reserved for telemetry. Aggregate storage is capped across restarts and writers. */
  readonly directory?: string;
  readonly maxQueuedRecords?: number;
  readonly maxFileBytes?: number;
  readonly retainedFiles?: number;
  /** A complete local OTLP/HTTP trace endpoint. Export is active only when enabled is true. */
  readonly otlpEndpoint?: string;
}

export interface Telemetry {
  emit(event: TelemetryEvent): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const NOOP: Telemetry = Object.freeze({ emit() {}, async flush() {}, async shutdown() {} });
export function telemetryEnabled(telemetry: Telemetry | undefined): boolean { return telemetry !== undefined && telemetry !== NOOP; }

export interface TelemetryContext {
  readonly executionId?: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly userSeq?: number;
  readonly callId?: string;
  readonly parentRunId?: string;
  readonly parentExecutionId?: string;
  readonly parentCallId?: string;
}

const telemetryContext = new AsyncLocalStorage<TelemetryContext>();

export function currentTelemetryContext(): TelemetryContext | undefined { return telemetryContext.getStore(); }

export function withTelemetryContext<T>(context: TelemetryContext, action: () => T): T {
  return telemetryContext.run(context, action);
}

/** Keep telemetry callbacks best-effort even when an injected implementation throws. */
export function emitTelemetry(telemetry: Telemetry | undefined, event: TelemetryEvent): void {
  if (!telemetryEnabled(telemetry)) return;
  try { telemetry!.emit(event); } catch { /* Observability must not affect runtime behavior. */ }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;
const CODE = /^[a-z][a-z0-9_]{0,79}$/u;

function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function validName(value: unknown): value is string { return typeof value === 'string' && NAME.test(value); }
function validCount(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function validDuration(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function validPositiveCount(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1; }

function withLogMetadata(event: Record<string, string | number | boolean>, component: string,
  severity: 'debug' | 'info' | 'warn' | 'error'): Record<string, string | number | boolean> {
  return { ...event, component, severity };
}

function safeEvent(value: TelemetryEvent): Record<string, string | number | boolean> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const event = value as unknown as Record<string, unknown>;
  if (!validId(event.executionId) || (event.runId !== undefined && !validId(event.runId))
    || (event.sessionId !== undefined && !validId(event.sessionId))
    || (event.userSeq !== undefined && !validCount(event.userSeq))) return undefined;
  const base: Record<string, string | number | boolean> = { type: event.type as string, executionId: event.executionId as string,
    ...(event.runId === undefined ? {} : { runId: event.runId as string }),
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId as string }),
    ...(event.userSeq === undefined ? {} : { userSeq: event.userSeq as number }) };
  const boundedParentKeys = ['parentExecutionId', 'parentRunId', 'parentCallId'];
  if (boundedParentKeys.some(key => event[key] !== undefined && !validId(event[key]))) return undefined;
  const parent = {
    ...(event.parentExecutionId === undefined ? {} : { parentExecutionId: event.parentExecutionId as string }),
    ...(event.parentRunId === undefined ? {} : { parentRunId: event.parentRunId as string }),
    ...(event.parentCallId === undefined ? {} : { parentCallId: event.parentCallId as string }),
  };
  if (event.type === 'run.started') {
    const keys = ['type', 'executionId', 'runId', 'sessionId', 'userSeq', ...boundedParentKeys];
    if (Object.keys(event).some(key => !keys.includes(key))) return undefined;
    return withLogMetadata({ ...base, ...parent }, 'loop', 'info');
  }
  if (event.type === 'run.finished') {
    const keys = ['type', 'executionId', 'runId', 'sessionId', 'userSeq', 'status', 'durationMs', 'modelCalls', 'toolCalls', 'errorCode'];
    if (Object.keys(event).some(key => !keys.includes(key)) || !['completed', 'failed', 'cancelled'].includes(String(event.status))
      || !validDuration(event.durationMs) || !validCount(event.modelCalls) || !validCount(event.toolCalls)
      || (event.errorCode !== undefined && (typeof event.errorCode !== 'string' || !CODE.test(event.errorCode)))) return undefined;
    return withLogMetadata({ ...base, status: event.status as string, durationMs: event.durationMs, modelCalls: event.modelCalls,
      toolCalls: event.toolCalls, ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }) },
    'loop', event.status === 'failed' ? 'error' : event.status === 'cancelled' ? 'warn' : 'info');
  }
  if (event.type === 'model.started' || event.type === 'model.finished') {
    const started = event.type === 'model.started';
    const keys = ['type', 'executionId', 'runId', 'sessionId', 'userSeq', 'requestId', 'logicalRequestId', 'attempt', 'provider', 'model',
      ...(started ? [] : ['durationMs', 'status', 'inputTokens', 'outputTokens', 'cacheSource', 'cacheSourceFields', 'cacheHitInputTokens',
        'cacheMissInputTokens', 'cacheCreationInputTokens', 'cacheUncachedInputTokens', 'providerInputIncludesCache', 'cacheConsistent',
        'finishReason', 'errorCode'])];
    if (Object.keys(event).some(key => !keys.includes(key)) || !validId(event.requestId) || !validId(event.logicalRequestId)
      || !validPositiveCount(event.attempt) || event.attempt > 100) return undefined;
    const result = { ...base, requestId: event.requestId as string, logicalRequestId: event.logicalRequestId as string,
      attempt: event.attempt as number, ...(validName(event.provider) ? { provider: event.provider } : {}),
      ...(validName(event.model) ? { model: event.model } : {}) };
    if (started) return withLogMetadata(result, 'model', 'info');
    if (!validDuration(event.durationMs) || (event.inputTokens !== undefined && !validCount(event.inputTokens))
      || (event.outputTokens !== undefined && !validCount(event.outputTokens))
      || (event.status !== 'completed' && event.status !== 'failed' && event.status !== 'cancelled')
      || (event.cacheSource !== undefined && event.cacheSource !== 'chat-completions' && event.cacheSource !== 'anthropic-messages')
      || (event.cacheSourceFields !== undefined && (typeof event.cacheSourceFields !== 'string'
        || event.cacheSourceFields.length > 512 || !/^[A-Za-z0-9_.,:-]+$/u.test(event.cacheSourceFields)))
      || (event.cacheHitInputTokens !== undefined && !validCount(event.cacheHitInputTokens))
      || (event.cacheMissInputTokens !== undefined && !validCount(event.cacheMissInputTokens))
      || (event.cacheCreationInputTokens !== undefined && !validCount(event.cacheCreationInputTokens))
      || (event.cacheUncachedInputTokens !== undefined && !validCount(event.cacheUncachedInputTokens))
      || (event.providerInputIncludesCache !== undefined && typeof event.providerInputIncludesCache !== 'boolean')
      || (event.cacheConsistent !== undefined && typeof event.cacheConsistent !== 'boolean')
      || (event.finishReason !== undefined && !['stop', 'tool_calls', 'length', 'max_tokens', 'unknown'].includes(String(event.finishReason)))
      || (event.errorCode !== undefined && (typeof event.errorCode !== 'string' || !CODE.test(event.errorCode)))) return undefined;
    const cacheFields = typeof event.cacheSourceFields === 'string' ? event.cacheSourceFields : undefined;
    return withLogMetadata({ ...result, durationMs: event.durationMs as number, status: event.status,
      ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens as number }),
      ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens as number }),
      ...(event.cacheSource === undefined ? {} : { cacheSource: event.cacheSource }),
      ...(cacheFields === undefined ? {} : { cacheSourceFields: cacheFields }),
      ...(event.cacheHitInputTokens === undefined ? {} : { cacheHitInputTokens: event.cacheHitInputTokens as number }),
      ...(event.cacheMissInputTokens === undefined ? {} : { cacheMissInputTokens: event.cacheMissInputTokens as number }),
      ...(event.cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens: event.cacheCreationInputTokens as number }),
      ...(event.cacheUncachedInputTokens === undefined ? {} : { cacheUncachedInputTokens: event.cacheUncachedInputTokens as number }),
      ...(event.providerInputIncludesCache === undefined ? {} : { providerInputIncludesCache: event.providerInputIncludesCache as boolean }),
      ...(event.cacheConsistent === undefined ? {} : { cacheConsistent: event.cacheConsistent as boolean }),
      ...(event.finishReason === undefined ? {} : { finishReason: event.finishReason as string }),
      ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode as string }) }, 'model',
    event.status === 'failed' ? 'error' : event.status === 'cancelled' ? 'warn' : 'info');
  }
  if (event.type === 'tool.started' || event.type === 'tool.finished') {
    const started = event.type === 'tool.started';
    const keys = ['type', 'executionId', 'runId', 'sessionId', 'userSeq', 'callId', 'tool',
      ...(started ? [] : ['durationMs', 'outcome', 'errorCode'])];
    if (Object.keys(event).some(key => !keys.includes(key)) || !validId(event.callId) || !validName(event.tool)) return undefined;
    const result = { ...base, callId: event.callId as string, tool: event.tool as string };
    if (started) return withLogMetadata(result, 'kernel', 'info');
    if (!validDuration(event.durationMs) || !['success', 'failure', 'refused', 'cancelled'].includes(String(event.outcome))
      || (event.errorCode !== undefined && (typeof event.errorCode !== 'string' || !CODE.test(event.errorCode)))) return undefined;
    return withLogMetadata({ ...result, durationMs: event.durationMs as number, outcome: event.outcome as string,
      ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode as string }) }, 'kernel',
    event.outcome === 'failure' ? 'error' : event.outcome === 'success' ? 'info' : 'warn');
  }
  if (event.type === 'approval.started' || event.type === 'approval.finished') {
    if (!validId(event.sessionId)) return undefined;
    const started = event.type === 'approval.started';
    const keys = ['type', 'executionId', 'runId', 'sessionId', 'userSeq', ...boundedParentKeys, 'callId', 'requestId',
      ...(started ? [] : ['durationMs', 'decision', 'errorCode'])];
    if (Object.keys(event).some(key => !keys.includes(key)) || !validId(event.requestId)
      || (event.callId !== undefined && !validId(event.callId))) return undefined;
    const result = { ...base, ...parent, ...(event.callId === undefined ? {} : { callId: event.callId as string }),
      requestId: event.requestId as string };
    if (started) return withLogMetadata(result, 'policy', 'info');
    if (!validDuration(event.durationMs) || !['allow', 'deny', 'cancelled', 'error'].includes(String(event.decision))
      || (event.errorCode !== undefined && (typeof event.errorCode !== 'string' || !CODE.test(event.errorCode)))) return undefined;
    return withLogMetadata({ ...result, durationMs: event.durationMs as number, decision: event.decision as string,
      ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode as string }) }, 'policy',
    event.decision === 'error' ? 'error' : event.decision === 'allow' ? 'info' : 'warn');
  }
  if (event.type === 'compaction.started' || event.type === 'compaction.finished') {
    const started = event.type === 'compaction.started';
    const keys = ['type', 'executionId', 'runId', 'sessionId', 'userSeq', 'operationId', 'operation', 'inputMessages',
      ...(started ? [] : ['status', 'durationMs', 'outputMessages', 'errorCode'])];
    if (Object.keys(event).some(key => !keys.includes(key)) || !validId(event.operationId)
      || !['prepare', 'recover', 'explicit'].includes(String(event.operation)) || !validCount(event.inputMessages)) return undefined;
    const result = { ...base, operationId: event.operationId as string, operation: event.operation as string,
      inputMessages: event.inputMessages as number };
    if (started) return withLogMetadata(result, 'compaction', 'info');
    if (!validDuration(event.durationMs) || !['completed', 'unchanged', 'failed', 'cancelled'].includes(String(event.status))
      || (event.outputMessages !== undefined && !validCount(event.outputMessages))
      || (event.errorCode !== undefined && (typeof event.errorCode !== 'string' || !CODE.test(event.errorCode)))) return undefined;
    return withLogMetadata({ ...result, status: event.status as string, durationMs: event.durationMs as number,
      ...(event.outputMessages === undefined ? {} : { outputMessages: event.outputMessages as number }),
      ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode as string }) }, 'compaction',
    event.status === 'failed' ? 'error' : event.status === 'cancelled' ? 'warn' : 'info');
  }
  return undefined;
}

interface SegmentEntry {
  readonly name: string;
  readonly bytes: number;
  readonly dev: string;
  readonly ino: string;
}

interface Manifest {
  readonly version: 1;
  readonly maxFileBytes: number;
  readonly retainedFiles: number;
  readonly segments: readonly SegmentEntry[];
}

interface FileIdentity { readonly dev: string; readonly ino: string }

/** Bounded local JSONL telemetry plus an optional, loopback-only OTLP trace sink. */
export function createTelemetry(options: TelemetryOptions = {}, onStorageFailure?: (code: string) => void): Telemetry {
  if (options.enabled !== true) return NOOP;
  const endpoint = checkedOtlpEndpoint(options.otlpEndpoint);
  const localEnabled = typeof options.directory === 'string' && options.directory !== '';
  if (!localEnabled && endpoint === undefined) return NOOP;
  const queueLimit = options.maxQueuedRecords ?? MAX_QUEUE_RECORDS;
  const fileLimit = options.maxFileBytes ?? MAX_FILE_BYTES;
  const retainedFiles = options.retainedFiles ?? MAX_RETAINED_FILES;
  if (!Number.isSafeInteger(queueLimit) || queueLimit < 1 || queueLimit > MAX_QUEUE_RECORDS
    || !Number.isSafeInteger(fileLimit) || fileLimit < MAX_RECORD_BYTES + 1 || fileLimit > MAX_FILE_BYTES
    || !Number.isSafeInteger(retainedFiles) || retainedFiles < 1 || retainedFiles > MAX_RETAINED_FILES
    || retainedFiles + 2 > MAX_DIRECTORY_FILES || fileLimit * retainedFiles + MAX_MANIFEST_BYTES * 2 > MAX_TOTAL_BYTES) {
    if (localEnabled && endpoint !== undefined) throw new KernelError('telemetry_options_invalid');
    if (endpoint === undefined) return NOOP;
  }
  const otlp = endpoint === undefined ? undefined : createOtlpTraceSink(endpoint);

  const requestedDirectory = localEnabled ? resolve(options.directory!) : '';
  let directory = requestedDirectory;
  let directoryIdentity: FileIdentity | undefined;
  const manifestName = 'telemetry.manifest.json';
  let manifestPath = join(directory, manifestName);
  let lockPath = `${directory}.telemetry.lock`;
  let queue: string[] = [];
  let pendingRecords = 0;
  let draining: Promise<void> | undefined;
  let closed = false;
  let failed = false;
  let failureCode: string | undefined;

  async function acquireLock(): Promise<() => Promise<void>> {
    const info = await lstat(requestedDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('telemetry output must be an existing real directory');
    const canonical = await realpath(requestedDirectory);
    const canonicalInfo = await lstat(canonical);
    if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()) throw new Error('telemetry output path changed');
    if (process.platform !== 'win32' && (canonicalInfo.mode & 0o077) !== 0) {
      throw new Error('telemetry output directory must be private to its owner');
    }
    if (directoryIdentity !== undefined && (directory !== canonical || directoryIdentity.dev !== String(canonicalInfo.dev)
      || directoryIdentity.ino !== String(canonicalInfo.ino))) {
      throw new Error('telemetry output directory identity changed');
    }
    directory = canonical;
    manifestPath = join(directory, manifestName);
    lockPath = `${directory}.telemetry.lock`;
    directoryIdentity = { dev: String(canonicalInfo.dev), ino: String(canonicalInfo.ino) };
    try {
      const currentLock = await lstat(lockPath);
      if (!currentLock.isDirectory() || currentLock.isSymbolicLink() || !(await lockfile.check(directory, {
        realpath: false, lockfilePath: lockPath, stale: LOCK_STALE_MS,
      }))) throw new Error('telemetry lock path is unknown or invalid');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let compromised: Error | undefined;
    const release = await lockfile.lock(directory, {
      realpath: false,
      lockfilePath: lockPath,
      stale: LOCK_STALE_MS,
      update: Math.floor(LOCK_STALE_MS / 3),
      retries: { retries: 30, minTimeout: 10, maxTimeout: 75 },
      onCompromised: error => { compromised = error; },
    });
    try {
      const afterLock = await lstat(directory);
      if (compromised !== undefined || !afterLock.isDirectory() || afterLock.isSymbolicLink()
        || String(afterLock.dev) !== directoryIdentity.dev || String(afterLock.ino) !== directoryIdentity.ino) {
        throw compromised ?? new Error('telemetry output directory identity changed under lock');
      }
      return async () => release();
    } catch (error) {
      await release();
      throw error;
    }
  }

  function validRegularFile(info: Awaited<ReturnType<typeof lstat>>, identity?: FileIdentity): boolean {
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1
      && (identity === undefined || (String(info.dev) === identity.dev && String(info.ino) === identity.ino));
  }

  function parseManifest(value: unknown): Manifest | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'maxFileBytes,retainedFiles,segments,version'
      || record.version !== 1 || record.maxFileBytes !== fileLimit || record.retainedFiles !== retainedFiles
      || !Array.isArray(record.segments) || record.segments.length > retainedFiles) return undefined;
    const segments: SegmentEntry[] = [];
    const names = new Set<string>();
    let previous = -1;
    let total = 0;
    for (const item of record.segments) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
      const entry = item as Record<string, unknown>;
      if (Object.keys(entry).sort().join(',') !== 'bytes,dev,ino,name'
        || typeof entry.name !== 'string' || !/^segment-[0-9]{8}\.jsonl$/u.test(entry.name)
        || !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0 || (entry.bytes as number) > fileLimit
        || typeof entry.dev !== 'string' || !/^\d+$/u.test(entry.dev)
        || typeof entry.ino !== 'string' || !/^\d+$/u.test(entry.ino)) return undefined;
      const sequence = Number(entry.name.slice('segment-'.length, -'.jsonl'.length));
      if (sequence <= previous || names.has(entry.name)) return undefined;
      previous = sequence;
      names.add(entry.name);
      total += entry.bytes as number;
      segments.push({ name: entry.name, bytes: entry.bytes as number, dev: entry.dev, ino: entry.ino });
    }
    if (total > fileLimit * retainedFiles || total + MAX_MANIFEST_BYTES * 2 > MAX_TOTAL_BYTES) return undefined;
    return { version: 1, maxFileBytes: fileLimit, retainedFiles, segments };
  }

  async function writeNewManifest(manifest: Manifest): Promise<FileIdentity> {
    const contents = JSON.stringify(manifest);
    if (Buffer.byteLength(contents, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('telemetry manifest exceeds its size limit');
    const handle = await open(manifestPath, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      const info = await handle.stat();
      if (!validRegularFile(info)) throw new Error('telemetry manifest is not an exclusive regular file');
      return { dev: String(info.dev), ino: String(info.ino) };
    } finally { await handle.close(); }
  }

  async function replaceManifest(manifest: Manifest, previous: FileIdentity): Promise<FileIdentity> {
    const contents = JSON.stringify(manifest);
    if (Buffer.byteLength(contents, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('telemetry manifest exceeds its size limit');
    const temporaryPath = join(directory, `telemetry.manifest.${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, 'wx', 0o600);
    let temporaryIdentity: FileIdentity | undefined;
    let handleClosed = false;
    let renamed = false;
    try {
      const created = await handle.stat();
      if (!validRegularFile(created)) throw new Error('telemetry temporary manifest is not an exclusive regular file');
      temporaryIdentity = { dev: String(created.dev), ino: String(created.ino) };
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      const temporary = await lstat(temporaryPath);
      if (!validRegularFile(temporary, temporaryIdentity)) throw new Error('telemetry temporary manifest identity changed');
      const current = await lstat(manifestPath);
      if (!validRegularFile(current, previous)) throw new Error('telemetry manifest identity changed');
      await fs.rename(temporaryPath, manifestPath);
      renamed = true;
      await handle.close();
      handleClosed = true;
      const replaced = await lstat(manifestPath);
      if (!validRegularFile(replaced, temporaryIdentity)) throw new Error('telemetry manifest replacement is invalid');
      return { dev: String(replaced.dev), ino: String(replaced.ino) };
    } catch (error) {
      if (!renamed && temporaryIdentity !== undefined) {
        try {
          const candidate = await lstat(temporaryPath);
          if (validRegularFile(candidate, temporaryIdentity)) await unlink(temporaryPath);
        } catch { /* Missing or changed paths are never cleaned up as this writer's temporary file. */ }
      }
      if (!handleClosed) {
        try { await handle.close(); handleClosed = true; } catch { /* Keep the original failure and retain the temporary path. */ }
      }
      throw error;
    } finally {
      if (!handleClosed) {
        try { await handle.close(); } catch { /* The operation result remains authoritative. */ }
      }
    }
  }

  async function readManifest(): Promise<{ readonly manifest: Manifest; readonly identity: FileIdentity }> {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== directoryIdentity?.dev || String(info.ino) !== directoryIdentity?.ino) {
      throw new Error('telemetry output directory identity changed');
    }
    const entries = await readdir(directory);
    if (entries.length > MAX_DIRECTORY_FILES) throw new Error('telemetry directory file-count limit exceeded');
    // Even under the directory lock, a matching filename does not prove that this process owns the file.
    // Preserve it and fail closed; recovery must not delete user data based on a naming convention.
    if (entries.some(name => MANIFEST_TEMP_NAME.test(name))) throw new KernelError('telemetry_manifest_temp_unknown');
    let markerInfo: Awaited<ReturnType<typeof lstat>> | undefined;
    try { markerInfo = await lstat(manifestPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (markerInfo === undefined) {
      if (entries.length !== 0) throw new KernelError('telemetry_storage_unknown_file');
      const manifest: Manifest = { version: 1, maxFileBytes: fileLimit, retainedFiles, segments: [] };
      const identity = await writeNewManifest(manifest);
      return { manifest, identity };
    }
    if (!validRegularFile(markerInfo) || markerInfo.size > MAX_MANIFEST_BYTES) throw new Error('telemetry manifest is not a valid regular file');
    const contents = await readFile(manifestPath, 'utf8');
    let parsed: unknown;
    try { parsed = JSON.parse(contents); }
    catch { throw new KernelError('telemetry_manifest_invalid'); }
    const manifest = parseManifest(parsed);
    if (manifest === undefined) {
      throw new KernelError('telemetry_manifest_invalid');
    }
    const expectedNames = new Set([manifestName, ...manifest.segments.map(segment => segment.name)]);
    if (entries.length !== expectedNames.size || entries.some(name => !expectedNames.has(name))) {
      throw new KernelError('telemetry_storage_unknown_file');
    }
    for (const segment of manifest.segments) {
      const segmentInfo = await lstat(join(directory, segment.name));
      if (!validRegularFile(segmentInfo, segment) || segmentInfo.size !== segment.bytes) {
        throw new Error('telemetry segment identity or size changed');
      }
    }
    return { manifest, identity: { dev: String(markerInfo.dev), ino: String(markerInfo.ino) } };
  }

  async function createSegment(manifest: Manifest, markerIdentity: FileIdentity): Promise<{ manifest: Manifest; markerIdentity: FileIdentity }> {
    let segments = [...manifest.segments];
    let currentMarker = markerIdentity;
    if (segments.length >= retainedFiles) {
      const oldest = segments[0];
      const path = join(directory, oldest.name);
      const info = await lstat(path);
      if (!validRegularFile(info, oldest) || info.size !== oldest.bytes) throw new Error('telemetry segment identity changed');
      await unlink(path);
      segments.shift();
      currentMarker = await replaceManifest({ ...manifest, segments }, currentMarker);
      manifest = { ...manifest, segments };
    }
    const nextSequence = segments.length === 0 ? 0 : Number(segments.at(-1)!.name.slice('segment-'.length, -'.jsonl'.length)) + 1;
    if (nextSequence > 99_999_999) throw new Error('telemetry segment sequence exhausted');
    const name = `segment-${String(nextSequence).padStart(8, '0')}.jsonl`;
    const handle = await open(join(directory, name), 'wx', 0o600);
    let identity: FileIdentity;
    try {
      const info = await handle.stat();
      if (!validRegularFile(info)) throw new Error('telemetry segment is not an exclusive regular file');
      identity = { dev: String(info.dev), ino: String(info.ino) };
      await handle.sync();
    } finally { await handle.close(); }
    segments = [...segments, { name, bytes: 0, ...identity }];
    const next = { ...manifest, segments };
    currentMarker = await replaceManifest(next, currentMarker);
    return { manifest: next, markerIdentity: currentMarker };
  }

  async function appendLine(line: string): Promise<void> {
    const release = await acquireLock();
    try {
      if (closed || failed) return;
      let { manifest, identity } = await readManifest();
      const bytes = Buffer.byteLength(line, 'utf8');
      let segment = manifest.segments.at(-1);
      if (segment === undefined || segment.bytes + bytes > fileLimit) {
        const created = await createSegment(manifest, identity);
        manifest = created.manifest;
        identity = created.markerIdentity;
        segment = manifest.segments.at(-1);
      }
      if (segment === undefined || segment.bytes + bytes > fileLimit) throw new Error('telemetry record exceeds the file limit');
      const path = join(directory, segment.name);
      const before = await lstat(path);
      if (!validRegularFile(before, segment) || before.size !== segment.bytes) throw new Error('telemetry segment identity changed');
      const noFollow = constants.O_NOFOLLOW ?? 0;
      const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | noFollow);
      let afterSize: number;
      try {
        const opened = await handle.stat();
        if (!validRegularFile(opened, segment) || opened.size !== segment.bytes) throw new Error('telemetry segment changed while opening');
        await handle.writeFile(line, 'utf8');
        afterSize = (await handle.stat()).size;
        if (afterSize !== segment.bytes + bytes) throw new Error('telemetry segment write was incomplete');
      } finally { await handle.close(); }
      const updatedSegments = manifest.segments.map(item => item.name === segment!.name ? { ...item, bytes: afterSize } : item);
      await replaceManifest({ ...manifest, segments: updatedSegments }, identity);
    } finally { await release(); }
  }

  async function drain(): Promise<void> {
    while (queue.length > 0 && !closed && !failed) {
      const line = queue.shift()!;
      try { await appendLine(line); }
      catch (error) {
        // Unknown files, lock failures, and I/O failures permanently disable this writer instance.
        failed = true;
        failureCode = error instanceof KernelError ? error.code : 'telemetry_storage_failed';
        try { onStorageFailure?.(failureCode); } catch { /* Diagnostics must not affect Agent execution. */ }
        queue.length = 0;
        pendingRecords = 0;
      } finally {
        if (!failed) pendingRecords -= 1;
      }
    }
  }

  function startDrain(): void {
    if (draining !== undefined || closed || failed) return;
    draining = drain().finally(() => { draining = undefined; if (queue.length > 0 && !closed && !failed) startDrain(); });
  }

  async function flushLocal(): Promise<void> {
    while (draining !== undefined || queue.length > 0) {
      if (draining === undefined) startDrain();
      await draining;
    }
    if (failureCode !== undefined) throw new KernelError(failureCode);
  }

  async function flush(): Promise<void> {
    await Promise.all([flushLocal(), otlp?.flush() ?? Promise.resolve()]);
  }

  return {
    emit(event) {
      if (closed) return;
      const safe = safeEvent(event);
      if (safe === undefined) return;
      try { otlp?.emit(safe); } catch { /* Export instrumentation cannot change Agent results. */ }
      if (!localEnabled || failed || pendingRecords >= queueLimit) return;
      const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...safe })}\n`;
      if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) return;
      queue.push(line);
      pendingRecords += 1;
      startDrain();
    },
    flush,
    async shutdown() {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([flushLocal().catch(() => {}), otlp?.shutdown() ?? Promise.resolve()]).then(() => undefined, () => undefined),
        new Promise<void>(resolveTimeout => { timeout = setTimeout(resolveTimeout, 250); }),
      ]);
      if (timeout !== undefined) clearTimeout(timeout);
      closed = true;
      queue.length = 0;
      pendingRecords = 0;
    },
  };
}
