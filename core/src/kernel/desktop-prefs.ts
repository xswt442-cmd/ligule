// 桌面偏好文档按完整 JSON 保存；版本核对与替换都在同一把跨进程锁内完成。
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { dataRoot } from './config-file.js';
import { KernelError, KernelRuntimeError } from './error.js';
import { errorCode, errorMessage, isPlainObject } from '../shared/guards.js';
import { withLockedAtomicFile } from '../storage/locked-file.js';

/** 偏好文档的最大字节数。 */
export const DESKTOP_PREFS_LIMIT_BYTES = 1024 * 1024;

const PREFS_LOCK_STALE_MS = 10_000;

export function prefsPathOf(home = homedir()): string {
  return join(dataRoot(home), 'desktop.json');
}

function invalidPrefs(cause?: unknown): KernelError {
  return new KernelError('desktop_prefs_invalid', { cause, detail: 'the preferences document must be a JSON object' });
}

function parsePrefsBytes(bytes: Buffer): Record<string, unknown> {
  if (bytes.byteLength > DESKTOP_PREFS_LIMIT_BYTES) {
    throw new KernelError('desktop_prefs_too_large', {
      detail: `${bytes.byteLength} bytes is over the ${DESKTOP_PREFS_LIMIT_BYTES}-byte cap`,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    throw invalidPrefs(cause);
  }
  if (!isPlainObject(parsed)) throw invalidPrefs();
  return parsed;
}

async function readPrefsFile(path: string): Promise<{ settings: Record<string, unknown>; version: string; mode?: number }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { settings: {}, version: '' };
    throw error;
  }
  const settings = parsePrefsBytes(bytes);
  const fileStat = await stat(path);
  return {
    settings,
    version: createHash('sha256').update(bytes).digest('hex'),
    mode: fileStat.mode & 0o777,
  };
}

/** 读取偏好文档；文件不存在时返回空对象，格式错误或超限时返回错误。 */
export async function loadPrefs(path = prefsPathOf()): Promise<Record<string, unknown>> {
  return (await readPrefsFile(resolve(path))).settings;
}

/** 同时读取偏好文档和内容版本；文件缺失时版本为空字符串。 */
export async function readPrefs(path = prefsPathOf()): Promise<{ settings: Record<string, unknown>; version: string }> {
  const { settings, version } = await readPrefsFile(resolve(path));
  return { settings, version };
}

/** 校验界面提交的值是可解析对象后才写入文件。 */
export function parsePrefsJson(json: string): Record<string, unknown> {
  return parsePrefsBytes(Buffer.from(json, 'utf8'));
}

export async function savePrefs(
  path: string,
  value: Record<string, unknown>,
  options: { version?: string } = {},
): Promise<{ settings: Record<string, unknown>; version: string }> {
  return withLockedAtomicFile(path, {
    lockStaleMs: PREFS_LOCK_STALE_MS,
    lockRetries: { retries: 6, minTimeout: 10, maxTimeout: 80 },
    renameMaxAttempts: 24,
    renameMaxBackoffMs: 250,
    errors: {
      onLockFailed: (cause, target) => errorCode(cause) === 'ELOCKED'
        ? new KernelError('desktop_prefs_locked', { cause, detail: `${target} has an active writer` })
        : new KernelRuntimeError('desktop_prefs_lock_failed', { cause, detail: target }),
      onLockLost: (cause, target) => new KernelRuntimeError('desktop_prefs_lock_lost', { cause, detail: target }),
      onUnlockFailed: (cause, target) => new KernelRuntimeError('desktop_prefs_unlock_failed', { cause, detail: target }),
      onReplaceFailed: (cause) => new KernelRuntimeError('desktop_prefs_replace_failed', { cause, detail: errorMessage(cause) }),
    },
    run: async ({ target }) => {
      const before = await readPrefsFile(target);
      if (options.version !== undefined && options.version !== before.version) {
        throw new KernelError('desktop_prefs_version_stale', { detail: `${target} changed since it was read; nothing was written` });
      }
      const json = `${JSON.stringify(value)}\n`;
      const settings = parsePrefsJson(json);
      const bytes = Buffer.from(json, 'utf8');
      return {
        content: bytes,
        mode: before.mode ?? 0o600,
        beforeRename: async () => {
          if ((await readPrefsFile(target)).version !== before.version) {
            throw new KernelError('desktop_prefs_version_stale', { detail: `${target} changed before replacement; nothing was written` });
          }
        },
        result: { settings, version: createHash('sha256').update(bytes).digest('hex') },
      };
    },
  });
}
