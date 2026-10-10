// 两端共用的那一份输入历史（方案 5.5.6）：发出去的句子跨会话留住，不进会话记录，也不给模型看。
// 终端界面与宿主各开各的进程，写的是同一个文件，所以那一次读—改—写要跨进程排队——与那份工作区登记同一套设施。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { dataRoot } from './config-file.js';
import { KernelError, KernelRuntimeError } from './error.js';

/** 内存里与文件里各留多少条：再长的历史没人往上翻那么多次。 */
export const HISTORY_LIMIT = 200;

/** 历史那一把锁的租期：一次读—改—写在毫秒级完成，超出这些毫秒就是写下它的人半路没了。 */
export const HISTORY_LOCK_STALE_MS = 5_000;

// 文件名沿用终端界面那一份：换名字会让已经在用的机器看不见自己攒下的历史，而这一处没有迁移设施（方案 5.5.5 那条未定）。
export function historyPathOf(home = homedir()): string {
  return join(dataRoot(home), 'tui-history.jsonl');
}

/** 发出去的那一句进历史的最前面，原来在历史里的那一条让位过来，尾上超预算的那几条丢掉。 */
export function pushHistory(entries: readonly string[], text: string, limit = HISTORY_LIMIT): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [...entries];
  return [trimmed, ...entries.filter((entry) => entry !== trimmed)].slice(0, limit);
}

/** 读那一份文件：一行一条、JSON 编码，最新的排在最前——一句多行的草稿仍然是一行，读回来不用猜边界。
 * 还没有过任何一次输入不是错误。 */
export async function loadHistory(path = historyPathOf()): Promise<string[]> {
  let bytes: string;
  try {
    bytes = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
  const entries: string[] = [];
  for (const line of bytes.split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new KernelError('input_history_invalid', { detail: `${path} line ${entries.length + 1} is not a JSON-encoded sentence` });
    }
    if (typeof parsed !== 'string') {
      throw new KernelError('input_history_invalid', { detail: `${path} line ${entries.length + 1} is not a sentence of text` });
    }
    entries.push(parsed);
    if (entries.length >= HISTORY_LIMIT) break;
  }
  return entries;
}

// 进程内按文件排一条队，跨进程取一把锁：两端同时发出去时，后写的那一份不能把前一份刚落的那句挤掉。
const pendingSaves = new Map<string, Promise<void>>();

/** 整份重写而不是追加：同一句只留最新那一份，文件也不跟着使用时长一直涨。
 * ponytail: 每次发送重写一遍 200 行以内的小文件，换的是「崩在半路也不丢历史」——先写临时文件再改名。 */
export async function rememberHistory(path: string, entries: readonly string[]): Promise<void> {
  const queued = pendingSaves.get(path) ?? Promise.resolve();
  const current = queued.catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const release = await acquireHistoryLock(path);
    try {
      const existing = await loadHistory(path);
      const merged = [...new Set([...entries, ...existing])].slice(0, HISTORY_LIMIT);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, merged.map((entry) => JSON.stringify(entry)).join('\n') + '\n', { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    } finally {
      await release();
    }
  });
  pendingSaves.set(path, current);
  try {
    await current;
  } finally {
    if (pendingSaves.get(path) === current) pendingSaves.delete(path);
  }
}

/** 那把锁：拿到就交回一个释放动作；等不到就说清是哪一份文件被占着。 */
async function acquireHistoryLock(path: string): Promise<() => Promise<void>> {
  try {
    return await lockfile.lock(path, {
      realpath: false,
      lockfilePath: `${path}.lock`,
      stale: HISTORY_LOCK_STALE_MS,
      retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
      onCompromised: () => {},
    });
  } catch (cause) {
    throw new KernelRuntimeError('input_history_locked', { cause, detail: path });
  }
}

export async function flushHistory(path: string): Promise<void> {
  await pendingSaves.get(path);
}
