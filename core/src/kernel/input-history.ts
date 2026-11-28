// CLI/TUI 与 Desktop 共用已发送输入历史；历史跨会话保留，不写入会话记录，也不提供给模型。
// 两端可能运行在不同进程，因此读—改—写需要跨进程锁。
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataRoot } from './config-file.js';
import { KernelError, KernelRuntimeError } from './error.js';
import { flushLockedFile, withLockedAtomicFile } from '../storage/locked-file.js';

/** 内存和文件中保留的最大历史条数。 */
export const HISTORY_LIMIT = 200;

/** 历史文件锁的过期时间；正常读—改—写应在此时间内完成。 */
export const HISTORY_LOCK_STALE_MS = 5_000;

// 保持现有历史文件名，确保已使用过的输入历史仍可读取。
export function historyPathOf(home = homedir()): string {
  return join(dataRoot(home), 'tui-history.jsonl');
}

/** 将新发送的输入移至历史首位，删除重复项，并裁剪超出上限的最旧内容。 */
export function pushHistory(entries: readonly string[], text: string, limit = HISTORY_LIMIT): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [...entries];
  return [trimmed, ...entries.filter((entry) => entry !== trimmed)].slice(0, limit);
}

/** 读取 JSONL 历史文件；每行一条输入，最新记录在最前。文件不存在时返回空历史。 */
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

/** 在锁内读取最新历史，合并新输入并去重，再通过临时文件和原子重命名整体写回。
 * 返回写入后的完整历史，供界面更新显示。
 */
export async function rememberHistory(path: string, fresh: readonly string[]): Promise<string[]> {
  return withLockedAtomicFile(path, {
    lockStaleMs: HISTORY_LOCK_STALE_MS,
    lockRetries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
    errors: {
      onLockFailed: (cause, target) => new KernelRuntimeError('input_history_locked', { cause, detail: target }),
    },
    run: async ({ target }) => {
      const existing = await loadHistory(target);
      // `fresh` 按最新在先排列；新增内容排在磁盘历史前面，并移除重复项。
      const added = [...new Set(fresh.map((entry) => entry.trim()).filter((entry) => entry !== ''))];
      const written = [...new Set([...added, ...existing])].slice(0, HISTORY_LIMIT);
      return {
        content: written.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
        result: written,
      };
    },
  });
}

export async function flushHistory(path: string): Promise<void> {
  await flushLockedFile(path);
}
