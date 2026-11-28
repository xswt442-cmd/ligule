import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rm, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { KernelRuntimeError } from '../errors.js';
import type { ExecLogSnapshot } from '../capability/exec-log-types.js';

export const EXECUTION_LOG_NAME = /^execution-[0-9a-f-]{36}\.log\.json$/u;
export const MAX_EXECUTION_LOG_RAW_BYTES = 256 * 1024;
export const MAX_EXECUTION_LOG_FILE_BYTES = 1024 * 1024;

export interface ExecutionLogReference {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function executionLogRawBytes(snapshot: ExecLogSnapshot): number {
  return snapshot.chunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
}

export function executionLogEncodedBytes(executionId: string, snapshot: ExecLogSnapshot): number {
  return encode(snapshot, executionId).length;
}

function safeLogName(executionId: string): string {
  if (!/^[0-9a-f-]{36}$/u.test(executionId)) throw new KernelRuntimeError('session_execution_log_invalid');
  return `execution-${executionId}.log.json`;
}

function encode(snapshot: ExecLogSnapshot, executionId: string): Buffer {
  const rawBytes = executionLogRawBytes(snapshot);
  if (rawBytes > MAX_EXECUTION_LOG_RAW_BYTES || snapshot.chunks.length > 4096) {
    throw new KernelRuntimeError('session_execution_log_limit');
  }
  const value = {
    version: 1,
    executionId,
    totalBytes: snapshot.totalBytes,
    firstAvailableOffset: snapshot.firstAvailableOffset,
    chunks: snapshot.chunks.map((chunk) => ({
      sequence: chunk.sequence,
      stream: chunk.stream,
      offset: chunk.offset,
      dataBase64: chunk.data.toString('base64'),
    })),
  };
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  if (bytes.length > MAX_EXECUTION_LOG_FILE_BYTES) throw new KernelRuntimeError('session_execution_log_limit');
  return bytes;
}

export async function writeExecutionLog(directory: string, executionId: string,
  snapshot: ExecLogSnapshot): Promise<ExecutionLogReference> {
  const name = safeLogName(executionId);
  const root = await realpath(resolve(directory)).catch((cause: unknown) => {
    throw new KernelRuntimeError('session_execution_log_write_failed', { cause });
  });
  const path = join(root, name);
  const bytes = encode(snapshot, executionId);
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
    | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0);
  let file: FileHandle | undefined;
  let identity: { dev: bigint; ino: bigint } | undefined;
  try {
    file = await open(path, flags, 0o600);
    const opened = await file.stat({ bigint: true });
    identity = { dev: opened.dev, ino: opened.ino };
    await file.writeFile(bytes);
    await file.sync();
    if ((await file.stat({ bigint: true })).size !== BigInt(bytes.length)) {
      throw new KernelRuntimeError('session_execution_log_write_failed');
    }
    return { name, bytes: bytes.length, sha256: sha256(bytes) };
  } catch (cause) {
    if (identity !== undefined) {
      const current = await lstat(path, { bigint: true }).catch(() => undefined);
      if (current?.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
        await rm(path, { force: true }).catch(() => undefined);
      }
    }
    if (cause instanceof KernelRuntimeError) throw cause;
    throw new KernelRuntimeError('session_execution_log_write_failed', { cause });
  } finally {
    await file?.close();
  }
}

/** 只接受记录里能核对的日志引用；形状不对一律丢弃，交给调用方写“未知”。 */
export function checkedExecutionLogReference(value: unknown): ExecutionLogReference | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const reference = value as Record<string, unknown>;
  if (Object.keys(reference).some((key) => !['name', 'bytes', 'sha256'].includes(key))
    || typeof reference.name !== 'string' || !EXECUTION_LOG_NAME.test(reference.name)
    || !Number.isSafeInteger(reference.bytes) || Number(reference.bytes) < 1
    || Number(reference.bytes) > MAX_EXECUTION_LOG_FILE_BYTES
    || typeof reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.sha256)) return undefined;
  return { name: reference.name, bytes: Number(reference.bytes), sha256: reference.sha256 };
}

export async function readExecutionLog(directory: string, executionId: string, reference: ExecutionLogReference): Promise<ExecLogSnapshot> {  if (!EXECUTION_LOG_NAME.test(reference.name) || reference.name !== safeLogName(executionId)
    || !Number.isSafeInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > MAX_EXECUTION_LOG_FILE_BYTES
    || !/^[a-f0-9]{64}$/u.test(reference.sha256)) throw new KernelRuntimeError('session_execution_log_reference_invalid');
  const root = await realpath(resolve(directory));
  const path = join(root, reference.name);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(reference.bytes)) {
    throw new KernelRuntimeError('session_execution_log_file_invalid');
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat({ bigint: true });
    const actualPath = await realpath(path);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || actualPath !== path) {
      throw new KernelRuntimeError('session_execution_log_file_invalid');
    }
    const bytes = Buffer.alloc(reference.bytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const content = bytes.subarray(0, length);
    if (length !== reference.bytes || sha256(content) !== reference.sha256) {
      throw new KernelRuntimeError('session_execution_log_digest_invalid');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(content.toString('utf8')); }
    catch (cause) { throw new KernelRuntimeError('session_execution_log_invalid', { cause }); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new KernelRuntimeError('session_execution_log_invalid');
    const data = parsed as Record<string, unknown>;
    if (data.version !== 1 || data.executionId !== executionId || !Number.isSafeInteger(data.totalBytes)
      || Number(data.totalBytes) < 0 || !Number.isSafeInteger(data.firstAvailableOffset)
      || Number(data.firstAvailableOffset) < 0 || !Array.isArray(data.chunks) || data.chunks.length > 4096) {
      throw new KernelRuntimeError('session_execution_log_invalid');
    }
    let previousSequence = -1;
    let previousEnd = -1;
    const chunks = data.chunks.map((item): ExecLogSnapshot['chunks'][number] => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new KernelRuntimeError('session_execution_log_invalid');
      const chunk = item as Record<string, unknown>;
      if (!Number.isSafeInteger(chunk.sequence) || Number(chunk.sequence) < 0 || Number(chunk.sequence) <= previousSequence
        || (chunk.stream !== 'stdout' && chunk.stream !== 'stderr')
        || !Number.isSafeInteger(chunk.offset) || Number(chunk.offset) < 0
        || typeof chunk.dataBase64 !== 'string'
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(chunk.dataBase64)) {
        throw new KernelRuntimeError('session_execution_log_invalid');
      }
      const decoded = Buffer.from(chunk.dataBase64, 'base64');
      if (decoded.length === 0 || decoded.length > MAX_EXECUTION_LOG_RAW_BYTES
        || Number(chunk.offset) < previousEnd || Number(chunk.offset) + decoded.length > Number(data.totalBytes)) {
        throw new KernelRuntimeError('session_execution_log_invalid');
      }
      previousSequence = Number(chunk.sequence);
      previousEnd = Number(chunk.offset) + decoded.length;
      return { sequence: previousSequence, stream: chunk.stream, offset: Number(chunk.offset), data: decoded };
    });
    if (executionLogRawBytes({ chunks, totalBytes: Number(data.totalBytes), firstAvailableOffset: Number(data.firstAvailableOffset) })
      > MAX_EXECUTION_LOG_RAW_BYTES) throw new KernelRuntimeError('session_execution_log_limit');
    const actualFirst = chunks[0]?.offset ?? Number(data.totalBytes);
    if (Number(data.firstAvailableOffset) !== actualFirst || Number(data.firstAvailableOffset) > Number(data.totalBytes)) {
      throw new KernelRuntimeError('session_execution_log_invalid');
    }
    return { totalBytes: Number(data.totalBytes), firstAvailableOffset: Number(data.firstAvailableOffset), chunks };
  } finally {
    await file.close();
  }
}

export async function removeExecutionLog(directory: string, name: string): Promise<boolean> {
  if (!EXECUTION_LOG_NAME.test(name)) return false;
  const root = await realpath(resolve(directory)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (root === undefined) return true;
  const path = join(root, name);
  const before = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (before === undefined) return true;
  if (!before.isFile() || before.isSymbolicLink()) return false;
  const actualPath = await realpath(path).catch(() => undefined);
  if (actualPath !== path) return false;
  const current = await lstat(path, { bigint: true }).catch(() => undefined);
  if (current?.dev === before.dev && current.ino === before.ino && current.isFile() && !current.isSymbolicLink()) {
    await rm(path, { force: true });
    return true;
  }
  return false;
}

export async function scanExecutionLogs(directory: string, maximumBytes: number): Promise<{ readonly bytes: number; readonly complete: boolean }> {
  const root = await realpath(resolve(directory)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return null;
  });
  if (root === undefined) return { bytes: 0, complete: true };
  if (root === null) return { bytes: maximumBytes, complete: false };
  let names: string[];
  try { names = await readdir(root); }
  catch { return { bytes: maximumBytes, complete: false }; }
  let bytes = 0;
  for (const name of names) {
    if (!EXECUTION_LOG_NAME.test(name)) continue;
    const path = join(root, name);
    const info = await lstat(path, { bigint: true }).catch(() => undefined);
    if (info === undefined) continue;
    if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(MAX_EXECUTION_LOG_FILE_BYTES)) {
      return { bytes: maximumBytes, complete: false };
    }
    bytes += Number(info.size);
    if (bytes > maximumBytes) return { bytes: maximumBytes, complete: false };
  }
  return { bytes, complete: true };
}
