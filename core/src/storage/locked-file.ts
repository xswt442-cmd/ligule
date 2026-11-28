import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { errorCode, errorMessage } from '../shared/guards.js';

const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_LOCK_UPDATE_MS = 2_000;
const DEFAULT_LOCK_RETRIES = { retries: 8, minTimeout: 10, maxTimeout: 100 } as const;
const DEFAULT_RENAME_MAX_ATTEMPTS = 24;
const DEFAULT_RENAME_MAX_BACKOFF_MS = 250;
const WINDOWS_RETRYABLE_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

export interface LockedFileLock {
  assertOwned(): void;
  release(): Promise<void>;
}

export interface LockedFileErrorHandlers {
  readonly onLockFailed?: (cause: unknown, target: string) => Error;
  readonly onLockLost?: (cause: Error, target: string) => Error;
  readonly onUnlockFailed?: (cause: unknown, target: string) => Error;
  readonly onReplaceFailed?: (cause: unknown, target: string) => Error;
}

export type LockedFileWritePlan<T> =
  | {
    readonly write?: true;
    readonly content: string | Uint8Array;
    readonly mode?: number;
    readonly beforeRename?: () => Promise<void>;
    readonly result: T;
  }
  | {
    readonly write: false;
    readonly result: T;
  };

export interface LockedFileOptions<T> {
  readonly lockStaleMs?: number;
  readonly lockUpdateMs?: number;
  readonly lockRetries?: number | { readonly retries?: number; readonly minTimeout?: number; readonly maxTimeout?: number };
  readonly renameMaxAttempts?: number;
  readonly renameMaxBackoffMs?: number;
  readonly errors?: LockedFileErrorHandlers;
  readonly run: (context: { readonly target: string; readonly lock: LockedFileLock }) => Promise<LockedFileWritePlan<T>>;
}

// 同一进程内按规范化路径串行化写入，跨进程通过 `proper-lockfile` 协调。
const pendingByPath = new Map<string, Promise<unknown>>();

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(errorMessage(value));
}

async function acquireLock(
  target: string,
  options: LockedFileOptions<unknown>,
): Promise<LockedFileLock> {
  let compromised: Error | undefined;
  let unlock: (() => Promise<void>) | undefined;
  try {
    await mkdir(dirname(target), { recursive: true });
    unlock = await lockfile.lock(target, {
      realpath: false,
      lockfilePath: `${target}.lock`,
      stale: options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
      update: options.lockUpdateMs ?? DEFAULT_LOCK_UPDATE_MS,
      retries: options.lockRetries ?? DEFAULT_LOCK_RETRIES,
      onCompromised: (error) => { compromised = toError(error); },
    });
  } catch (cause) {
    if (options.errors?.onLockFailed !== undefined) {
      throw options.errors.onLockFailed(cause, target);
    }
    throw cause;
  }
  const throwLockLost = (cause: Error): never => {
    if (options.errors?.onLockLost !== undefined) {
      throw options.errors.onLockLost(cause, target);
    }
    throw cause;
  };
  return {
    assertOwned() {
      if (compromised !== undefined) throwLockLost(compromised);
    },
    async release() {
      if (compromised !== undefined) {
        await unlock?.().catch(() => undefined);
        throwLockLost(compromised);
      }
      try {
        await unlock!();
      } catch (cause) {
        if (compromised !== undefined) throwLockLost(compromised);
        if (options.errors?.onUnlockFailed !== undefined) {
          throw options.errors.onUnlockFailed(cause, target);
        }
        throw cause;
      }
    },
  };
}

export async function withLockedAtomicFile<T>(
  path: string,
  options: LockedFileOptions<T>,
  renameImpl?: (source: string, destination: string) => Promise<void>,
): Promise<T> {
  const target = resolve(path);
  const previous = pendingByPath.get(target) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const lock = await acquireLock(target, options as LockedFileOptions<unknown>);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let temporaryCreated = false;
    try {
      const plan = await options.run({ target, lock });
      if (plan.write === false) return plan.result;

      lock.assertOwned();
      const handle = await open(temporary, 'wx', 0o600);
      temporaryCreated = true;
      try {
        if (typeof plan.content === 'string') {
          await handle.writeFile(plan.content, 'utf8');
        } else {
          await handle.writeFile(plan.content);
        }
        if (plan.mode !== undefined && plan.mode !== 0o600) {
          await handle.chmod(plan.mode);
        }
      } finally {
        await handle.close();
      }

      const maxAttempts = options.renameMaxAttempts ?? DEFAULT_RENAME_MAX_ATTEMPTS;
      const maxBackoffMs = options.renameMaxBackoffMs ?? DEFAULT_RENAME_MAX_BACKOFF_MS;
      const doRename = renameImpl ?? rename;

      for (let attempt = 0; ; attempt += 1) {
        lock.assertOwned();
        if (plan.beforeRename !== undefined) await plan.beforeRename();
        try {
          await doRename(temporary, target);
          temporaryCreated = false;
          break;
        } catch (cause) {
          const code = errorCode(cause) ?? '';
          const retryable = process.platform === 'win32' && WINDOWS_RETRYABLE_RENAME_CODES.has(code) && attempt < maxAttempts;
          if (!retryable) {
            if (options.errors?.onReplaceFailed !== undefined) {
              throw options.errors.onReplaceFailed(cause, target);
            }
            throw cause;
          }
        }
        await delay(Math.min(20 * (2 ** attempt), maxBackoffMs));
      }

      return plan.result;
    } finally {
      try {
        if (temporaryCreated) await rm(temporary, { force: true });
      } finally {
        await lock.release();
      }
    }
  });

  pendingByPath.set(target, current);
  try {
    return await current;
  } finally {
    if (pendingByPath.get(target) === current) pendingByPath.delete(target);
  }
}

export async function flushLockedFile(path: string): Promise<void> {
  await pendingByPath.get(resolve(path));
}
