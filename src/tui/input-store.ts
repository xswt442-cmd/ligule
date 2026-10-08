// 终端界面的草稿与排着的那几句（D81 边界二、方案 5.1）：跨退出留住的一小份文件，不进会话记录也不进内核。
// 一行一份会话：`{ projectRoot, sessionId, draft, queued }`，同一份会话再写一次就换掉旧的那一行，最新的排在最后。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type SavedInput = { projectRoot: string; sessionId: string; draft: string; queued: string[] };

/** 最多留多少份会话的：再老的会话人也不再回去接着写了。 */
export const INPUT_LIMIT = 50;
const DRAFT_LIMIT = 8000;
const QUEUE_LIMIT = 20;

export function inputPathOf(userHome = homedir()): string {
  return join(userHome, '.ligule', 'tui-input.jsonl');
}

// 读不懂的那一行跳过：这一份是界面上的方便之物，不是事实源，坏一行不该让整份会话都开不了。
export function parseInputs(bytes: string): SavedInput[] {
  const found: SavedInput[] = [];
  for (const line of bytes.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const value = parsed as Partial<SavedInput>;
    if (typeof value?.sessionId !== 'string') continue;
    found.push({
      projectRoot: typeof value.projectRoot === 'string' ? value.projectRoot : '',
      sessionId: value.sessionId,
      draft: typeof value.draft === 'string' ? value.draft.slice(0, DRAFT_LIMIT) : '',
      queued: Array.isArray(value.queued) ? value.queued.filter((item): item is string => typeof item === 'string').slice(0, QUEUE_LIMIT) : [],
    });
  }
  return found;
}

async function load(path: string): Promise<SavedInput[]> {
  try {
    return parseInputs(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
}

/** 那一份会话留下的那一句草稿与排着的几句；没留过就是空的。 */
export async function readInput(path: string, projectRoot: string, sessionId: string): Promise<SavedInput> {
  const entries = await load(path);
  const empty = { projectRoot, sessionId, draft: '', queued: [] as string[] };
  // 同 id 在不同项目根下是两份会话：两格都对上才算这一份的。
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (entry.sessionId === sessionId && entry.projectRoot === projectRoot) return entry;
  }
  return empty;
}

const pendingWrites = new Map<string, Promise<void>>();

/** 整份重写而不是追加：同一份会话只留最新的一行，文件也不跟着会话数一直涨。
 * ponytail: 一次保存重写 50 行以内的小文件，换的是「崩在半路也不留下半行」——先写临时文件再改名。 */
export async function rememberInput(path: string, entry: SavedInput): Promise<void> {
  const previous = pendingWrites.get(path) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const kept = (await load(path)).filter((item) => !(item.sessionId === entry.sessionId && item.projectRoot === entry.projectRoot));
    // 两句都没了就不留这一行：那一格本来就是为了留住没发出去的话。
    const next = entry.draft === '' && entry.queued.length === 0 ? kept : [...kept, entry].slice(-INPUT_LIMIT);
    if (next.length === 0) {
      await rm(path, { force: true });
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${next.map((item) => JSON.stringify(item)).join('\n')}\n`, { flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  });
  pendingWrites.set(path, current);
  try {
    await current;
  } finally {
    if (pendingWrites.get(path) === current) pendingWrites.delete(path);
  }
}

export async function flushInput(path: string): Promise<void> {
  await pendingWrites.get(path);
}
