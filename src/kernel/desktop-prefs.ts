// 桌面那一份草稿与界面偏好文档（方案 5.5.2）：草稿、暂停队列、语言、通知与外观这类偏好按桌面留在应用数据根里，
// WebView 缓存里那一份只当第一屏的快速读法，可恢复的输入不靠它。整份替换：先写临时文件再改名，
// 崩在半路也不会留下一份写了一半的文档；这一处不读旧内容，所以不需要输入历史那把跨进程锁。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { dataRoot } from './config-file.js';
import { KernelError } from './error.js';

/** 一份偏好文档的字节上限：草稿按 4000 字一份、队列 20 句一份算，正常使用远到不了这里。 */
export const DESKTOP_PREFS_LIMIT_BYTES = 1024 * 1024;

export function prefsPathOf(home = homedir()): string {
  return join(dataRoot(home), 'desktop.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读那一份文档：还没有过任何一次保存不是错误；读坏了就用默认（与界面那一侧同一句话），不猜它想表达什么。 */
export async function loadPrefs(path = prefsPathOf()): Promise<Record<string, unknown>> {
  let bytes: string;
  try {
    bytes = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return {};
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(bytes);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 界面交来的那一份必须是能解析的对象：坏东西不进文件（信任边界在这一次调用上）。 */
export function parsePrefsJson(json: string): Record<string, unknown> {
  const size = Buffer.byteLength(json, 'utf8');
  if (size > DESKTOP_PREFS_LIMIT_BYTES) {
    throw new KernelError('desktop_prefs_too_large', { detail: `${size} bytes is over the ${DESKTOP_PREFS_LIMIT_BYTES}-byte cap` });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new KernelError('desktop_prefs_invalid', { cause, detail: 'the preferences document is not JSON' });
  }
  if (!isPlainObject(parsed)) {
    throw new KernelError('desktop_prefs_invalid', { detail: 'the preferences document is not a JSON object' });
  }
  return parsed;
}

// 进程内按文件排一条队：两次保存差不多同时到，后发起的那一份才是最后该留在文件里的那一份。
const pendingSaves = new Map<string, Promise<void>>();

export async function savePrefs(path: string, value: Record<string, unknown>): Promise<void> {
  const queued = pendingSaves.get(path) ?? Promise.resolve();
  const current = queued.catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  });
  pendingSaves.set(path, current);
  try {
    await current;
  } finally {
    if (pendingSaves.get(path) === current) pendingSaves.delete(path);
  }
}
