// 会话列表的可重建索引：缓存每条记录解析出的列表字段，按文件大小和修改时间失效。
// 索引是纯缓存，记录文件仍是唯一事实来源；读取失败或格式不符时整体丢弃并重建。
// 写入失败不影响列表结果，与投影缓存同样按 fail-soft 处理。
import { open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { SessionSummary } from './list.js';

export const LIST_INDEX_VERSION = 1;
export const LIST_INDEX_NAME = 'index.json';

interface ListIndexEntry {
  bytes: number;
  mtimeMs: number;
  // 首行声明或目录推断前的原始项目根；空值表示归属未知。
  headerRoot: string | null;
  summary: SessionSummary;
}

interface ListIndexFile {
  version: number;
  entries: Record<string, ListIndexEntry>;
}

export interface ListIndex {
  entries: Map<string, ListIndexEntry>;
}

// 缓存条目必须携带完整的列表字段：残缺条目按未命中处理，从记录重建。
// 会话规则要求列表始终由记录文件派生，索引只是缓存，不提供第二份事实。
function entryShape(value: unknown, id: string): value is ListIndexEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<ListIndexEntry>;
  const summary = entry.summary as Partial<SessionSummary> | undefined;
  return typeof entry.bytes === 'number' && Number.isFinite(entry.bytes)
    && typeof entry.mtimeMs === 'number' && Number.isFinite(entry.mtimeMs)
    && (entry.headerRoot === null || typeof entry.headerRoot === 'string')
    && typeof summary === 'object' && summary !== null
    && summary.id === id
    && typeof summary.formatVersion === 'number'
    && typeof summary.projectRoot === 'string'
    && typeof summary.workspace === 'string'
    && typeof summary.workspaceOrigin === 'string'
    && (summary.createdAt === null || typeof summary.createdAt === 'string')
    && typeof summary.updatedAt === 'string'
    && typeof summary.events === 'number'
    && typeof summary.lastSeq === 'number'
    && typeof summary.name === 'string'
    && typeof summary.archived === 'boolean'
    && typeof summary.unanswered === 'number'
    && typeof summary.truncatedBytes === 'number'
    && (summary.mode === null || (typeof summary.mode === 'object' && summary.mode !== null
      && typeof summary.mode.name === 'string' && typeof summary.mode.layer === 'string' && typeof summary.mode.digest === 'string'))
    && (summary.error === undefined || (typeof summary.error === 'object' && summary.error !== null
      && typeof summary.error.code === 'string' && typeof summary.error.detail === 'string'));
}

// 读取失败、JSON 损坏或版本不符都返回空索引：调用方按未命中逐条重建。
export async function readListIndex(directory: string): Promise<ListIndex> {
  let text: string;
  try {
    text = await readFile(join(directory, LIST_INDEX_NAME), 'utf8');
  } catch {
    return { entries: new Map() };
  }
  try {
    const parsed = JSON.parse(text) as Partial<ListIndexFile>;
    if (parsed.version !== LIST_INDEX_VERSION || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return { entries: new Map() };
    }
    const entries = new Map<string, ListIndexEntry>();
    for (const [id, value] of Object.entries(parsed.entries)) {
      if (entryShape(value, id)) entries.set(id, value);
    }
    return { entries };
  } catch {
    return { entries: new Map() };
  }
}

// 临时文件加原子替换写入；任何失败都静默放弃，下一次列表会重建。
export async function writeListIndex(directory: string, entries: Map<string, ListIndexEntry>): Promise<void> {
  const file: ListIndexFile = {
    version: LIST_INDEX_VERSION,
    entries: Object.fromEntries(entries),
  };
  const target = join(directory, LIST_INDEX_NAME);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(JSON.stringify(file), 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    created = false;
  } catch {
    // 索引写不进去只损失性能；记录读取路径不受影响。
  } finally {
    if (created) await rm(temporary, { force: true }).catch(() => {});
  }
}

export type { ListIndexEntry };
