// 终端界面的输入历史（D81 边界二）：跨会话留住的那一份草稿来源，不进会话记录也不进内核。
// 文件里一行一条、JSON 编码，最新的排在最前——一句多行的草稿仍然是一行，读回来不用猜边界。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 内存里与文件里各留多少条：再长的历史没人往上翻那么多次。 */
export const HISTORY_LIMIT = 200;

/** 反查那几行的条数上限：清单超过这个数就挡住输入框本身了。 */
export const SEARCH_ROWS = 8;

const pendingSaves = new Map<string, Promise<void>>();

export function historyPathOf(userHome = homedir()): string {
  return join(userHome, '.ligule', 'tui-history.jsonl');
}

/** 发出去的那一句进历史的最前面，原来在历史里的那一条让位过来，尾上超预算的那几条丢掉。 */
export function pushHistory(entries: readonly string[], text: string, limit = HISTORY_LIMIT): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [...entries];
  return [trimmed, ...entries.filter((entry) => entry !== trimmed)].slice(0, limit);
}

/** 反查：含这一段的那些条，从新到旧，重复内容只留一次。空查询不猜，交回空的。 */
export function searchHistory(entries: readonly string[], query: string, limit = SEARCH_ROWS): string[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === '') return [];
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().includes(wanted)) continue;
    if (found.includes(entry)) continue;
    found.push(entry);
    if (found.length >= limit) break;
  }
  return found;
}

export async function loadHistory(path: string): Promise<string[]> {
  let bytes: string;
  try {
    bytes = await readFile(path, 'utf8');
  } catch (error) {
    // 还没有过任何一次输入不是错误。
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
      const error = new Error(`tui_history_invalid: ${path}`) as Error & { code: string; line: number };
      error.code = 'tui_history_invalid';
      error.line = entries.length + 1;
      throw error;
    }
    if (typeof parsed !== 'string') {
      const error = new Error(`tui_history_invalid: ${path}`) as Error & { code: string; line: number };
      error.code = 'tui_history_invalid';
      error.line = entries.length + 1;
      throw error;
    }
    entries.push(parsed);
    if (entries.length >= HISTORY_LIMIT) break;
  }
  return entries;
}

/** 整份重写而不是追加：同一句只留最新那一份，文件也不跟着使用时长一直涨。
 * ponytail: 每次发送重写一遍 200 行以内的小文件，换的是「崩在半路也不丢历史」——先写临时文件再改名。 */
export async function rememberHistory(path: string, entries: readonly string[]): Promise<void> {
  const previous = pendingSaves.get(path) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    let existing: string[] = [];
    try {
      existing = await loadHistory(path);
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
    const merged = [...new Set([...entries, ...existing])].slice(0, HISTORY_LIMIT);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, merged.map((entry) => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx' });
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

export async function flushHistory(path: string): Promise<void> {
  await pendingSaves.get(path);
}
