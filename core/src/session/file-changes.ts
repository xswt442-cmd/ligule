import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { versionOf } from '../kernel/observe.js';

export const FILE_CHANGE_MAX_FILE_BYTES = 256 * 1024;
export const FILE_CHANGE_MAX_SESSION_BYTES = 16 * 1024 * 1024;

export interface FileChangeSnapshotReference {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface FileChangeFact extends Record<string, unknown> {
  readonly path: string;
  readonly operation: 'create' | 'write' | 'edit' | 'delete';
  readonly outcome: 'written' | 'unchanged' | 'unknown';
  readonly beforeVersion: string | null;
  readonly expectedAfterVersion: string | null;
  readonly observedAfterVersion: string | null;
  readonly observedAt: string;
  readonly baselineStatus: 'available' | 'unavailable' | 'unknown';
  readonly baselineExists: boolean | null;
  readonly baselineVersion: string | null;
  readonly baselineReason?: string;
  readonly baselineRef?: FileChangeSnapshotReference;
  readonly observedStatus: 'available' | 'unavailable' | 'unknown';
  readonly observedReason?: string;
  readonly observedExists: boolean | null;
  readonly expectedMatchesObserved: boolean | null;
  readonly changedFromBaseline: boolean | null;
  readonly beforeObject?: Record<string, unknown>;
}

export interface FileChangeMutation {
  readonly path: string;
  readonly target: string;
  readonly operation: FileChangeFact['operation'];
  readonly outcome: FileChangeFact['outcome'];
  readonly beforeExists: boolean;
  readonly beforeBytes?: Uint8Array;
  readonly expectedAfterExists: boolean;
  readonly expectedAfterBytes?: Uint8Array;
  readonly allowReadback?: boolean;
  readonly beforeObject?: Record<string, unknown>;
}

export interface ToolFileChangeRecorder {
  record(mutation: FileChangeMutation): Promise<void>;
}

interface Baseline {
  readonly status: FileChangeFact['baselineStatus'];
  readonly reason?: string;
  readonly exists: boolean | null;
  readonly version: string | null;
  readonly ref?: FileChangeSnapshotReference;
  readonly bytes?: Buffer;
}

interface FileChangeSession {
  readonly id?: string;
  readonly directory: string;
  read?(): Promise<readonly Record<string, unknown>[]>;
}

const SNAPSHOT_NAME = /^change-[a-f0-9]{16}-[0-9a-f-]{36}\.snapshot$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^[a-f0-9]{16}$/u;

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkedReference(value: unknown): FileChangeSnapshotReference | undefined {
  if (!isRecord(value) || Object.keys(value).some(key => !['name', 'bytes', 'sha256'].includes(key))
    || typeof value.name !== 'string' || !SNAPSHOT_NAME.test(value.name)
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0 || Number(value.bytes) > FILE_CHANGE_MAX_FILE_BYTES
    || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) return undefined;
  return { name: value.name, bytes: Number(value.bytes), sha256: value.sha256 };
}

function checkedVersion(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && VERSION.test(value));
}

export function checkedFileChangeFact(value: unknown): FileChangeFact | undefined {
  if (!isRecord(value) || typeof value.path !== 'string' || value.path.length === 0 || value.path.length > 2048
    || Object.keys(value).some(key => !['path', 'operation', 'outcome', 'beforeVersion', 'expectedAfterVersion', 'observedAfterVersion',
      'observedAt', 'baselineStatus', 'baselineReason', 'baselineRef', 'baselineExists', 'baselineVersion', 'observedStatus',
      'observedReason', 'observedExists', 'expectedMatchesObserved', 'changedFromBaseline', 'beforeObject'].includes(key))
    || value.path.startsWith('/') || /^[A-Za-z]:/u.test(value.path) || value.path.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(value.path) || value.path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
    || !['create', 'write', 'edit', 'delete'].includes(String(value.operation))
    || !['written', 'unchanged', 'unknown'].includes(String(value.outcome))
    || !checkedVersion(value.beforeVersion) || !checkedVersion(value.expectedAfterVersion)
    || !checkedVersion(value.observedAfterVersion) || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))
    || !['available', 'unavailable', 'unknown'].includes(String(value.baselineStatus))
    || (value.baselineExists !== null && typeof value.baselineExists !== 'boolean')
    || !checkedVersion(value.baselineVersion)
    || !['available', 'unavailable', 'unknown'].includes(String(value.observedStatus))
    || (value.observedReason !== undefined && (typeof value.observedReason !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/u.test(value.observedReason)))
    || (value.baselineReason !== undefined && (typeof value.baselineReason !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/u.test(value.baselineReason)))
    || (value.observedExists !== null && typeof value.observedExists !== 'boolean')
    || (value.expectedMatchesObserved !== null && typeof value.expectedMatchesObserved !== 'boolean')
    || (value.changedFromBaseline !== null && typeof value.changedFromBaseline !== 'boolean')) return undefined;
  const reference = value.baselineRef === undefined ? undefined : checkedReference(value.baselineRef);
  if ((value.baselineRef !== undefined && reference === undefined)
    || (value.baselineStatus === 'available' && value.baselineExists === true && reference === undefined)
    || (value.operation === 'delete' && value.expectedAfterVersion !== null)
    || (value.operation !== 'delete' && value.expectedAfterVersion === null)) return undefined;
  if (value.beforeObject !== undefined) {
    if (!isRecord(value.beforeObject)) return undefined;
    const beforeObject = value.beforeObject;
    if (Object.keys(beforeObject).some(key => !['name', 'dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].includes(key))
      || typeof beforeObject.name !== 'string' || beforeObject.name.length > 2048
      || ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].some(key =>
        beforeObject[key] !== undefined && (typeof beforeObject[key] !== 'number' || !Number.isFinite(beforeObject[key])))) return undefined;
  }
  return value as unknown as FileChangeFact;
}

async function loadSnapshot(directory: string, reference: FileChangeSnapshotReference): Promise<Buffer | undefined> {
  try {
    const base = await realpath(directory);
    const path = join(directory, reference.name);
    const resolved = await realpath(path);
    const local = relative(base, resolved);
    const metadata = await lstat(path);
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      || metadata.isSymbolicLink() || !metadata.isFile()
      || metadata.size !== reference.bytes) return undefined;
    const bytes = await readFile(path);
    if (bytes.length !== reference.bytes || digest(bytes) !== reference.sha256 || !isUtf8(bytes)) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}

async function readBoundedText(path: string): Promise<{
  readonly status: 'available' | 'unavailable' | 'unknown';
  readonly exists: boolean | null;
  readonly bytes?: Buffer;
  readonly version: string | null;
  readonly reason?: string;
}> {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'available', exists: false, version: null };
    return { status: 'unknown', exists: null, version: null, reason: 'readback_stat_failed' };
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    return { status: 'unknown', exists: true, version: null, reason: 'readback_target_changed' };
  }
  if (metadata.size > FILE_CHANGE_MAX_FILE_BYTES) {
    return { status: 'unavailable', exists: true, version: null, reason: 'file_too_large' };
  }
  let handle;
  try {
    const flags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    handle = await open(path, flags);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      return { status: 'unknown', exists: true, version: null, reason: 'readback_target_changed' };
    }
    if (opened.size > FILE_CHANGE_MAX_FILE_BYTES) {
      return { status: 'unavailable', exists: true, version: null, reason: 'file_too_large' };
    }
    const buffer = Buffer.allocUnsafe(FILE_CHANGE_MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > FILE_CHANGE_MAX_FILE_BYTES) {
      return { status: 'unavailable', exists: true, version: null, reason: 'file_too_large' };
    }
    const after = await handle.stat();
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      return { status: 'unknown', exists: true, version: null, reason: 'file_changed_during_readback' };
    }
    const bytes = Buffer.from(buffer.subarray(0, length));
    const version = versionOf(bytes);
    if (!isUtf8(bytes)) return { status: 'unavailable', exists: true, version, reason: 'not_utf8_text' };
    return { status: 'available', exists: true, bytes, version };
  } catch {
    return { status: 'unknown', exists: null, version: null, reason: 'readback_failed' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function observeExistence(path: string): Promise<{
  readonly status: 'available' | 'unknown';
  readonly exists: boolean | null;
  readonly version: null;
  readonly reason?: string;
}> {
  try {
    const metadata = await lstat(path);
    return metadata.isSymbolicLink() ? { status: 'unknown', exists: true, version: null, reason: 'delete_target_changed' }
      : { status: 'available', exists: true, version: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'available', exists: false, version: null };
    return { status: 'unknown', exists: null, version: null, reason: 'delete_readback_failed' };
  }
}

export function createFileChangeStore(session: FileChangeSession): {
  forCall(records: FileChangeFact[]): ToolFileChangeRecorder;
} {
  const sessionPrefix = `change-${createHash('sha256').update(session.id ?? 'unowned-session').digest('hex').slice(0, 16)}-`;
  const baselines = new Map<string, Baseline>();
  let loaded = false;
  let usedBytes = 0;
  let quotaKnown = false;
  let queue = Promise.resolve();

  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = queue.then(action, action);
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async function initialize(): Promise<void> {
    if (loaded) return;
    loaded = true;
    const references = new Map<string, { path: string; reference: FileChangeSnapshotReference; version: string | null }>();
    try {
      for (const event of await session.read?.() ?? []) {
        if (event.kind !== 'tool' || !Array.isArray(event.fileChanges)) continue;
        for (const value of event.fileChanges) {
          if (!isRecord(value) || typeof value.path !== 'string' || baselines.has(value.path)) continue;
          const reference = checkedReference(value.baselineRef);
          const status = value.baselineStatus;
          if (status !== 'available' && status !== 'unavailable' && status !== 'unknown') continue;
          const baseline: Baseline = {
            status,
            exists: value.baselineExists === false ? false : value.baselineExists === true ? true : null,
            version: typeof value.baselineVersion === 'string' ? value.baselineVersion : null,
            ...(typeof value.baselineReason === 'string' ? { reason: value.baselineReason } : {}),
            ...(reference === undefined ? {} : { ref: reference }),
          };
          baselines.set(value.path, baseline);
          if (reference !== undefined) references.set(reference.name, { path: value.path, reference, version: baseline.version });
        }
      }
    } catch {
      // A damaged or unreadable history prevents reliable baseline recovery; later captures stay unknown.
    }
    try {
      for (const name of await readdir(session.directory)) {
        if (!name.startsWith(sessionPrefix) || !SNAPSHOT_NAME.test(name)) continue;
        try {
          const info = await lstat(join(session.directory, name));
          if (!info.isSymbolicLink() && info.isFile()) usedBytes += info.size;
        } catch { /* A concurrent cleanup only reduces the available quota. */ }
      }
      quotaKnown = true;
    } catch { /* Snapshot accounting fails closed below when a write is attempted. */ }
    for (const { path, reference, version } of references.values()) {
      const bytes = await loadSnapshot(session.directory, reference);
      const previous = baselines.get(path);
      if (previous === undefined) continue;
      baselines.set(path, bytes === undefined
        ? { status: 'unknown', exists: true, version, reason: 'baseline_snapshot_unavailable', ref: reference }
        : { ...previous, bytes });
    }
  }

  async function createBaseline(path: string, beforeExists: boolean, beforeBytes: Uint8Array | undefined): Promise<Baseline> {
    const existing = baselines.get(path);
    if (existing !== undefined) return existing;
    if (!beforeExists) {
      const absent: Baseline = { status: 'available', exists: false, version: null };
      baselines.set(path, absent);
      return absent;
    }
    if (beforeBytes === undefined) {
      const unavailable: Baseline = { status: 'unavailable', exists: true, version: null, reason: 'body_not_read' };
      baselines.set(path, unavailable);
      return unavailable;
    }
    const bytes = Buffer.from(beforeBytes);
    const version = versionOf(bytes);
    const unavailable = (reason: string, status: Baseline['status'] = 'unavailable'): Baseline => {
      const result: Baseline = { status, exists: true, version, reason };
      baselines.set(path, result);
      return result;
    };
    if (bytes.length > FILE_CHANGE_MAX_FILE_BYTES) return unavailable('file_too_large');
    if (!isUtf8(bytes)) return unavailable('not_utf8_text');
    if (!quotaKnown) return unavailable('session_quota_unknown', 'unknown');
    if (usedBytes + bytes.length > FILE_CHANGE_MAX_SESSION_BYTES) return unavailable('session_quota_exceeded');
    const reference: FileChangeSnapshotReference = {
      name: `${sessionPrefix}${randomUUID()}.snapshot`, bytes: bytes.length, sha256: digest(bytes),
    };
    try {
      await writeFile(join(session.directory, reference.name), bytes, { flag: 'wx', mode: 0o600 });
    } catch {
      return unavailable('baseline_snapshot_write_failed', 'unknown');
    }
    usedBytes += bytes.length;
    const result: Baseline = { status: 'available', exists: true, version, ref: reference, bytes };
    baselines.set(path, result);
    return result;
  }

  return {
    forCall(records) {
      return {
        async record(mutation) {
          await serialize(async () => {
            try {
              await initialize();
              const baseline = await createBaseline(mutation.path, mutation.beforeExists, mutation.beforeBytes);
              const observation = mutation.operation === 'delete'
                ? await observeExistence(mutation.target)
                : mutation.allowReadback === false
                  ? { status: 'unavailable' as const, exists: null, version: null, reason: 'readback_not_authorized' }
                  : await readBoundedText(mutation.target);
              const observedBytes = 'bytes' in observation ? observation.bytes : undefined;
              const expectedBytes = mutation.expectedAfterBytes === undefined ? undefined : Buffer.from(mutation.expectedAfterBytes);
              const expectedAfterVersion = expectedBytes === undefined ? null : versionOf(expectedBytes);
              const baselineChanged = baseline.exists === false
                ? observation.exists === null ? null : observation.exists
                : baseline.bytes !== undefined && observedBytes !== undefined
                  ? !baseline.bytes.equals(observedBytes)
                  : baseline.exists === true && observation.exists === false
                    ? true
                  : null;
              const expectedMatchesObserved = mutation.expectedAfterExists
                ? expectedBytes !== undefined && observedBytes !== undefined ? expectedBytes.equals(observedBytes) : null
                : observation.exists === null ? null : !observation.exists;
              const fact: FileChangeFact = {
                path: mutation.path,
                operation: mutation.operation,
                outcome: mutation.outcome,
                beforeVersion: mutation.beforeBytes === undefined ? null : versionOf(mutation.beforeBytes),
                expectedAfterVersion,
                observedAfterVersion: observation.version,
                observedAt: new Date().toISOString(),
                baselineStatus: baseline.status,
                ...(baseline.reason === undefined ? {} : { baselineReason: baseline.reason }),
                ...(baseline.ref === undefined ? {} : { baselineRef: baseline.ref }),
                baselineVersion: baseline.version,
                baselineExists: baseline.exists,
                observedStatus: observation.status,
                ...(observation.reason === undefined ? {} : { observedReason: observation.reason }),
                observedExists: observation.exists,
                expectedMatchesObserved,
                changedFromBaseline: baselineChanged,
                ...(mutation.beforeObject === undefined ? {} : { beforeObject: mutation.beforeObject }),
              };
              records.push(fact);
            } catch {
              // Evidence capture never blocks or changes the already authorized file operation.
              const fact: FileChangeFact = {
                path: mutation.path,
                operation: mutation.operation,
                outcome: mutation.outcome,
                beforeVersion: mutation.beforeBytes === undefined ? null : versionOf(mutation.beforeBytes),
                expectedAfterVersion: mutation.expectedAfterBytes === undefined ? null : versionOf(mutation.expectedAfterBytes),
                observedAfterVersion: null,
                observedAt: new Date().toISOString(),
                baselineStatus: 'unknown',
                baselineReason: 'change_evidence_unavailable',
                baselineExists: null,
                baselineVersion: null,
                observedStatus: 'unknown',
                observedReason: 'change_evidence_unavailable',
                observedExists: null,
                expectedMatchesObserved: null,
                changedFromBaseline: null,
                ...(mutation.beforeObject === undefined ? {} : { beforeObject: mutation.beforeObject }),
              };
              records.push(fact);
            }
          });
        },
      };
    },
  };
}
