import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, lstat, realpath, unlink } from 'node:fs/promises';
import { open, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const MAX_RECORD_BYTES = 1024;
const MAX_QUEUE_RECORDS = 256;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_RETAINED_FILES = 4;

export type TelemetryEvent =
  | { readonly type: 'run.started'; readonly executionId: string; readonly runId?: string; readonly sessionId?: string; readonly parentExecutionId?: string; readonly parentRunId?: string; readonly parentCallId?: string }
  | { readonly type: 'run.finished'; readonly executionId: string; readonly runId?: string; readonly sessionId?: string; readonly status: 'completed' | 'failed' | 'cancelled'; readonly durationMs: number; readonly modelCalls: number; readonly toolCalls: number; readonly errorCode?: string }
  | { readonly type: 'model.finished'; readonly executionId: string; readonly runId?: string; readonly sessionId?: string; readonly provider?: string; readonly model?: string; readonly durationMs: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly finishReason?: 'stop' | 'tool_calls' | 'length' | 'max_tokens' | 'unknown'; readonly errorCode?: string }
  | { readonly type: 'tool.finished'; readonly executionId: string; readonly runId?: string; readonly sessionId?: string; readonly callId?: string; readonly tool: string; readonly durationMs: number; readonly outcome: 'success' | 'failure' | 'refused' | 'cancelled' }
  | { readonly type: 'approval.finished'; readonly executionId: string; readonly runId?: string; readonly sessionId: string; readonly parentExecutionId?: string; readonly parentRunId?: string; readonly parentCallId?: string; readonly callId?: string; readonly requestId?: string; readonly durationMs: number; readonly decision: 'allow' | 'deny' | 'cancelled' | 'error' };

export interface TelemetryOptions {
  readonly enabled?: boolean;
  /** Existing, caller-selected directory reserved for telemetry output. Limits are per instance; no aggregate cap spans instances or restarts. */
  readonly directory?: string;
  readonly maxQueuedRecords?: number;
  readonly maxFileBytes?: number;
  readonly retainedFiles?: number;
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
// Long waits and runs are valid; safe-integer precision, rather than a short wall-time cap, is the bound.
function validDuration(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

function safeEvent(value: TelemetryEvent): Record<string, string | number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const event = value as unknown as Record<string, unknown>;
  if (!validId(event.executionId) || (event.runId !== undefined && !validId(event.runId))
    || (event.sessionId !== undefined && !validId(event.sessionId))) return undefined;
  if (event.type === 'run.started') {
    const keys = ['type', 'executionId', 'runId', 'sessionId', 'parentExecutionId', 'parentRunId', 'parentCallId'];
    if (Object.keys(event).some(key => !keys.includes(key)) || (event.parentExecutionId !== undefined && !validId(event.parentExecutionId))
      || (event.parentRunId !== undefined && !validId(event.parentRunId))
      || (event.parentCallId !== undefined && !validId(event.parentCallId))) return undefined;
    return { type: 'run.started', executionId: event.executionId as string,
      ...(event.runId === undefined ? {} : { runId: event.runId as string }),
      ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId as string }),
      ...(event.parentExecutionId === undefined ? {} : { parentExecutionId: event.parentExecutionId as string }),
      ...(event.parentRunId === undefined ? {} : { parentRunId: event.parentRunId as string }),
      ...(event.parentCallId === undefined ? {} : { parentCallId: event.parentCallId as string }) };
  }
  if (event.type === 'approval.finished' && !validId(event.sessionId)) return undefined;
  const base: Record<string, string | number> = { type: event.type as string, executionId: event.executionId as string,
    ...(event.runId === undefined ? {} : { runId: event.runId as string }),
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId as string }) };
  if (event.type === 'run.finished') {
    const keys = ['type', 'executionId', 'runId', 'sessionId', 'status', 'durationMs', 'modelCalls', 'toolCalls', 'errorCode'];
    if (Object.keys(event).some(key => !keys.includes(key)) || !['completed', 'failed', 'cancelled'].includes(String(event.status))
      || !validDuration(event.durationMs) || !validCount(event.modelCalls) || !validCount(event.toolCalls)
      || (event.errorCode !== undefined && (typeof event.errorCode !== 'string' || !CODE.test(event.errorCode)))) return undefined;
    return { ...base, status: event.status as string, durationMs: event.durationMs, modelCalls: event.modelCalls,
      toolCalls: event.toolCalls, ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }) };
  }
  if (event.type === 'model.finished') {
    const keys = ['type', 'executionId', 'runId', 'sessionId', 'provider', 'model', 'durationMs', 'inputTokens', 'outputTokens', 'finishReason', 'errorCode'];
    if (Object.keys(event).some(key => !keys.includes(key)) || !validDuration(event.durationMs)
      || (event.inputTokens !== undefined && !validCount(event.inputTokens)) || (event.outputTokens !== undefined && !validCount(event.outputTokens))
      || (event.finishReason !== undefined && !['stop', 'tool_calls', 'length', 'max_tokens', 'unknown'].includes(String(event.finishReason)))
      || (event.errorCode !== undefined && (typeof event.errorCode !== 'string' || !CODE.test(event.errorCode)))) return undefined;
    return { ...base, ...(validName(event.provider) ? { provider: event.provider } : {}), ...(validName(event.model) ? { model: event.model } : {}),
      durationMs: event.durationMs as number, ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens as number }),
      ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens as number }),
      ...(event.finishReason === undefined ? {} : { finishReason: event.finishReason as string }),
      ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode as string }) };
  }
  if (event.type === 'tool.finished') {
    const keys = ['type', 'executionId', 'runId', 'sessionId', 'callId', 'tool', 'durationMs', 'outcome'];
    if (Object.keys(event).some(key => !keys.includes(key)) || !validDuration(event.durationMs) || !validName(event.tool)
      || (event.callId !== undefined && !validId(event.callId))
      || !['success', 'failure', 'refused', 'cancelled'].includes(String(event.outcome))) return undefined;
    return { ...base, ...(event.callId === undefined ? {} : { callId: event.callId }), tool: event.tool as string,
      durationMs: event.durationMs as number, outcome: event.outcome as string };
  }
  if (event.type === 'approval.finished') {
    const keys = ['type', 'executionId', 'runId', 'sessionId', 'parentExecutionId', 'parentRunId', 'parentCallId', 'callId', 'requestId', 'durationMs', 'decision'];
    if (Object.keys(event).some(key => !keys.includes(key)) || !validDuration(event.durationMs)
      || (event.parentExecutionId !== undefined && !validId(event.parentExecutionId))
      || (event.parentRunId !== undefined && !validId(event.parentRunId))
      || (event.parentCallId !== undefined && !validId(event.parentCallId))
      || (event.callId !== undefined && !validId(event.callId))
      || (event.requestId !== undefined && !validId(event.requestId))
      || !['allow', 'deny', 'cancelled', 'error'].includes(String(event.decision))) return undefined;
    return { type: event.type, executionId: event.executionId as string,
      ...(event.runId === undefined ? {} : { runId: event.runId as string }), sessionId: event.sessionId as string,
      ...(event.parentExecutionId === undefined ? {} : { parentExecutionId: event.parentExecutionId as string }),
      ...(event.parentRunId === undefined ? {} : { parentRunId: event.parentRunId as string }),
      ...(event.parentCallId === undefined ? {} : { parentCallId: event.parentCallId as string }),
      ...(event.callId === undefined ? {} : { callId: event.callId as string }),
      ...(event.requestId === undefined ? {} : { requestId: event.requestId }), durationMs: event.durationMs as number,
      decision: event.decision as string };
  }
  return undefined;
}

/** Writes per-instance bounded local JSONL only; aggregate storage across instances is not capped. It does not implement OTLP. */
export function createTelemetry(options: TelemetryOptions = {}): Telemetry {
  if (options.enabled !== true || typeof options.directory !== 'string' || options.directory === '') return NOOP;
  const queueLimit = options.maxQueuedRecords ?? MAX_QUEUE_RECORDS;
  const fileLimit = options.maxFileBytes ?? MAX_FILE_BYTES;
  const retainedFiles = options.retainedFiles ?? MAX_RETAINED_FILES;
  if (!Number.isSafeInteger(queueLimit) || queueLimit < 1 || queueLimit > MAX_QUEUE_RECORDS
    || !Number.isSafeInteger(fileLimit) || fileLimit < MAX_RECORD_BYTES + 1 || fileLimit > MAX_FILE_BYTES
    || !Number.isSafeInteger(retainedFiles) || retainedFiles < 1 || retainedFiles > MAX_RETAINED_FILES) return NOOP;

  const requestedDirectory = resolve(options.directory);
  const instanceName = `telemetry-${randomUUID()}`;
  let instanceDirectory = '';
  let initialized: Promise<void> | undefined;
  let directoryIdentity: { readonly dev: number; readonly ino: number } | undefined;
  let current: { readonly name: string; readonly handle: FileHandle; readonly dev: number; readonly ino: number; size: number } | undefined;
  const segments: string[] = [];
  const identities = new Map<string, { readonly dev: number; readonly ino: number }>();
  let segmentNumber = 0;
  let queue: string[] = [];
  let pendingRecords = 0;
  let draining: Promise<void> | undefined;
  let closed = false;
  let failed = false;

  async function initialize(): Promise<void> {
    const info = await lstat(requestedDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('telemetry output must be an existing real directory');
    const canonical = await realpath(requestedDirectory);
    instanceDirectory = join(canonical, instanceName);
    // Each process receives a new exclusive directory; existing content is never rotated or deleted.
    await mkdir(instanceDirectory, { mode: 0o700 });
    const created = await lstat(instanceDirectory);
    if (!created.isDirectory() || created.isSymbolicLink()) throw new Error('telemetry instance directory is not a real directory');
    directoryIdentity = { dev: created.dev, ino: created.ino };
  }

  async function assertOwnedDirectory(): Promise<void> {
    const expected = directoryIdentity;
    if (expected === undefined) throw new Error('telemetry directory ownership is unknown');
    const actual = await lstat(instanceDirectory);
    if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Error('telemetry directory identity changed');
    }
  }

  async function createSegment(): Promise<void> {
    await assertOwnedDirectory();
    if (segments.length >= retainedFiles) {
      const oldest = segments[0];
      const expected = identities.get(oldest);
      if (expected === undefined) throw new Error('telemetry segment ownership is unknown');
      const path = join(instanceDirectory, oldest);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.dev !== expected.dev || info.ino !== expected.ino) {
        throw new Error('telemetry segment identity changed');
      }
      await unlink(path);
      segments.shift();
      identities.delete(oldest);
    }
    const name = `segment-${String(segmentNumber++).padStart(8, '0')}.jsonl`;
    const path = join(instanceDirectory, name);
    const handle = await open(path, 'wx', 0o600);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) {
      await handle.close();
      throw new Error('telemetry segment is not an exclusive regular file');
    }
    const identity = { dev: info.dev, ino: info.ino };
    identities.set(name, identity);
    segments.push(name);
    current = { name, handle, ...identity, size: 0 };
  }

  async function writeLine(line: string): Promise<void> {
    if (initialized === undefined) initialized = initialize();
    await initialized;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (current === undefined || current.size + bytes > fileLimit) {
      if (current !== undefined) {
        await current.handle.close();
        current = undefined;
      }
      await createSegment();
    }
    const target = current;
    if (target === undefined) throw new Error('telemetry segment was not created');
    await assertOwnedDirectory();
    const pathInfo = await lstat(join(instanceDirectory, target.name));
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1
      || pathInfo.dev !== target.dev || pathInfo.ino !== target.ino) throw new Error('telemetry segment identity changed');
    await target.handle.writeFile(line, 'utf8');
    target.size += bytes;
  }

  async function drain(): Promise<void> {
    while (queue.length > 0 && !closed && !failed) {
      const line = queue.shift()!;
      try { await writeLine(line); }
      catch {
        // Stop writing after any path/identity or I/O failure. Nothing is retried against an untrusted path.
        failed = true;
        queue.length = 0;
        pendingRecords = 0;
        await current?.handle.close().catch(() => {});
        current = undefined;
      } finally {
        if (!failed) pendingRecords -= 1;
      }
    }
  }

  function startDrain(): void {
    if (draining !== undefined || closed || failed) return;
    draining = drain().finally(() => { draining = undefined; if (queue.length > 0 && !closed && !failed) startDrain(); });
  }

  async function flush(): Promise<void> {
    while (draining !== undefined || queue.length > 0) {
      if (draining === undefined) startDrain();
      await draining;
    }
    await current?.handle.sync().catch(() => { failed = true; });
  }

  return {
    emit(event) {
      if (closed || failed || pendingRecords >= queueLimit) return;
      const safe = safeEvent(event);
      if (safe === undefined) return;
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
        flush().then(() => undefined, () => undefined),
        new Promise<void>((resolveTimeout) => { timeout = setTimeout(resolveTimeout, 250); }),
      ]);
      if (timeout !== undefined) clearTimeout(timeout);
      closed = true;
      queue.length = 0;
      pendingRecords = 0;
      void current?.handle.close().catch(() => {});
      current = undefined;
    },
  };
}
