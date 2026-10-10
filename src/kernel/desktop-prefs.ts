// 桌面偏好文档按完整 JSON 保存；版本核对与替换都在同一把跨进程锁内完成。
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { homedir } from 'node:os';
import { dataRoot } from './config-file.js';
import { KernelError, KernelRuntimeError } from './error.js';

/** 一份偏好文档的字节上限。 */
export const DESKTOP_PREFS_LIMIT_BYTES = 1024 * 1024;

const PREFS_LOCK_STALE_MS = 10_000;

export function prefsPathOf(home = homedir()): string {
  return join(dataRoot(home), 'desktop.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** 读偏好文档：文件不存在时返回空对象；坏文档与超限文档明确报错。 */
export async function loadPrefs(path = prefsPathOf()): Promise<Record<string, unknown>> {
  return (await readPrefsFile(resolve(path))).settings;
}

/** 读取偏好与其字节版本；缺失文件的版本为空串。 */
export async function readPrefs(path = prefsPathOf()): Promise<{ settings: Record<string, unknown>; version: string }> {
  const { settings, version } = await readPrefsFile(resolve(path));
  return { settings, version };
}

/** 界面交来的那一份必须是能解析的对象：坏东西不进文件。 */
export function parsePrefsJson(json: string): Record<string, unknown> {
  return parsePrefsBytes(Buffer.from(json, 'utf8'));
}

type PrefsLock = { assertOwned(): void; release(): Promise<void> };

async function acquirePrefsLock(path: string): Promise<PrefsLock> {
  let compromised: Error | undefined;
  let unlock: (() => Promise<void>) | undefined;
  try {
    await mkdir(dirname(path), { recursive: true });
    unlock = await lockfile.lock(path, {
      realpath: false,
      lockfilePath: `${path}.lock`,
      stale: PREFS_LOCK_STALE_MS,
      update: 2_000,
      retries: { retries: 6, minTimeout: 10, maxTimeout: 80 },
      onCompromised: (error) => { compromised = error; },
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new KernelError('desktop_prefs_locked', { cause, detail: `${path} has an active writer` });
    }
    throw new KernelRuntimeError('desktop_prefs_lock_failed', { cause, detail: path });
  }
  return {
    assertOwned() {
      if (compromised !== undefined) {
        throw new KernelRuntimeError('desktop_prefs_lock_lost', { cause: compromised, detail: path });
      }
    },
    async release() {
      if (compromised !== undefined) {
        throw new KernelRuntimeError('desktop_prefs_lock_lost', { cause: compromised, detail: path });
      }
      try {
        await unlock!();
      } catch (cause) {
        throw new KernelRuntimeError('desktop_prefs_unlock_failed', { cause, detail: path });
      }
    },
  };
}

// 进程内排队避免本进程同时写同一份文档；文件锁再保护其他 Host 进程。
const pendingSaves = new Map<string, Promise<{ settings: Record<string, unknown>; version: string }>>();

export async function savePrefs(
  path: string,
  value: Record<string, unknown>,
  options: { version?: string } = {},
): Promise<{ settings: Record<string, unknown>; version: string }> {
  const target = resolve(path);
  const queued = pendingSaves.get(target) ?? Promise.resolve({ settings: {}, version: '' });
  const current = queued.catch(() => ({ settings: {}, version: '' })).then(async () => {
    const lock = await acquirePrefsLock(target);
    let temporary: string | undefined;
    try {
      const before = await readPrefsFile(target);
      if (options.version !== undefined && options.version !== before.version) {
        throw new KernelError('desktop_prefs_version_stale', { detail: `${target} changed since it was read; nothing was written` });
      }
      const json = `${JSON.stringify(value)}\n`;
      const settings = parsePrefsJson(json);
      const bytes = Buffer.from(json, 'utf8');
      lock.assertOwned();
      temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await chmod(temporary, before.mode ?? 0o600);
      lock.assertOwned();
      await rename(temporary, target);
      temporary = undefined;
      return { settings, version: createHash('sha256').update(bytes).digest('hex') };
    } finally {
      try {
        if (temporary !== undefined) await rm(temporary, { force: true });
      } finally {
        await lock.release();
      }
    }
  });
  pendingSaves.set(target, current);
  try {
    return await current;
  } finally {
    if (pendingSaves.get(target) === current) pendingSaves.delete(target);
  }
}
