// 会话列表扫描记录目录；主目录使用可重建索引缓存解析结果，按文件大小与修改时间失效。
// 从每条记录读取格式版本、项目归属、更新时间、事件数、最后生效模式和未完成调用数量。
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { dataRoot } from '../data-root.js';
import { KernelError } from '../errors.js';
import type { ModeFile } from '../kernel/modes.js';
import { workspaceIdentity } from '../workspace-identity.js';
import { sessionDirectories, type SessionDirectoryConfig } from '../workspace-storage.js';
import { findUnresolvedCalls } from './repair.js';
import type { SessionEvent, SessionHeader } from './format.js';
import { foldLabel } from './format.js';
import { parseSessionBytes } from './record.js';
import { readListIndex, writeListIndex, type ListIndexEntry } from './list-index.js';
import type { SessionSummary } from './list-types.js';

export type { SessionSummary } from './list-types.js';

// 恢复时优先使用客户端明确指定的模式；否则使用记录中最后生效的模式并校验摘要。
// 同名模式的摘要变化时返回错误，要求用户明确选择，不静默切换工具范围。
export function chooseResumeMode({
  explicit,
  recorded,
  loaded,
  fallback,
}: {
  explicit?: string;
  recorded?: { name: string; digest?: string };
  loaded?: ModeFile;
  fallback: string;
}): string {
  if (explicit !== undefined) return explicit;
  if (recorded === undefined) return fallback;
  // 版本 0 记录的模式事件没有摘要，因此只比较模式名称。
  if (recorded.digest !== undefined && recorded.digest !== loaded?.digest) {
    throw new KernelError('resume_mode_changed', {
      detail: `${recorded.name} was ${recorded.digest} in that session and is ${loaded?.digest ?? 'unreadable'} on disk; name a mode explicitly to resume`,
    });
  }
  return recorded.name;
}

export { sessionDirectories, sessionDirectory, splitUncIdentity, workspaceDataDirectory, type SessionDirectoryConfig } from '../workspace-storage.js';

function projectRootOfLegacyDirectory(directory: string): string | undefined {
  const resolved = resolve(directory);
  if (resolved === resolve(join(dataRoot(), 'sessions'))) return undefined;
  if (basename(resolved) !== 'sessions' || basename(dirname(resolved)) !== '.ligule') return undefined;
  return dirname(dirname(resolved));
}

export async function listSessions(
  directory: string,
  { projectRoot = undefined as string | undefined, limit = undefined as number | undefined, index = false } = {},
): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
  // 索引只属于当前目录，且只是缓存：未命中或失效的条目按原路径完整解析。
  const cache = index ? await readListIndex(directory) : { entries: new Map<string, ListIndexEntry>() };
  const fresh = new Map<string, ListIndexEntry>();
  let dirty = false;
  const summaries: SessionSummary[] = [];
  // 按目录身份筛选，而不是比较路径文本；记录和命令行可能使用不同大小写、分隔符或链接写法。
  // 文本不同时才解析路径身份，避免不必要的文件系统调用。
  const asked = projectRoot === undefined ? undefined : resolve(projectRoot);
  const askedIdentity = asked === undefined ? undefined : workspaceIdentity(asked);
  const physicalProjectRoot = projectRootOfLegacyDirectory(directory);
  const physicalIdentity = physicalProjectRoot === undefined ? undefined : workspaceIdentity(physicalProjectRoot);
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    const path = join(directory, name);
    const info = await stat(path);
    const cached = cache.entries.get(id);
    if (cached !== undefined && cached.bytes === info.size && cached.mtimeMs === info.mtimeMs) {
      fresh.set(id, cached);
      const cachedRoot = cached.headerRoot;
      if (asked !== undefined && cachedRoot !== null
        && resolve(cachedRoot) !== asked && workspaceIdentity(cachedRoot) !== askedIdentity) continue;
      if (asked !== undefined && cachedRoot === null
        && (physicalProjectRoot === undefined || physicalIdentity !== askedIdentity)) continue;
      summaries.push({ ...cached.summary, updatedAt: info.mtime.toISOString() });
      continue;
    }
    const bytes = await readFile(path);
    // 首行元数据提供项目归属；损坏或不支持的记录仍以错误条目显示在列表中。
    let header: SessionHeader | undefined;
    try {
      const end = bytes.indexOf(0x0a);
      const first: unknown = JSON.parse(bytes.subarray(0, end < 0 ? 0 : end).toString('utf8'));
      if (first !== null && typeof first === 'object' && (first as { kind?: unknown }).kind === 'session') header = first as SessionHeader;
    } catch {
      // 完整记录校验负责报告正文或首行错误；不推测损坏记录的项目归属。
    }
    // 指定项目根后只保留归属该项目的记录；无法读取首行的情况由后续错误处理负责。
    // 被筛选跳过的记录保留旧缓存条目，索引不因筛选视图而反复重写。
    const headerRoot = typeof header?.projectRoot === 'string' && header.projectRoot !== '' ? header.projectRoot : undefined;
    if (asked !== undefined && headerRoot !== undefined
      && resolve(headerRoot) !== asked && workspaceIdentity(headerRoot) !== askedIdentity) {
      const previous = cache.entries.get(id);
      if (previous !== undefined) fresh.set(id, previous);
      continue;
    }
    if (asked !== undefined && headerRoot === undefined
      && (physicalProjectRoot === undefined || physicalIdentity !== askedIdentity)) {
      const previous = cache.entries.get(id);
      if (previous !== undefined) fresh.set(id, previous);
      continue;
    }
    // 没有首行的记录只按实际记录目录归属；数据根中归属未知的记录仅出现在未筛选列表。
    const ownRoot = headerRoot ?? physicalProjectRoot ?? '';
    dirty = true;
    let events: SessionEvent[] = [];
    let truncatedBytes = 0;
    let invalid: SessionSummary['error'];
    let lastSeq = -1;
    try {
      const record = parseSessionBytes(bytes);
      events = record.events;
      truncatedBytes = record.truncatedBytes;
      lastSeq = record.lastSeq;
      header = record.header;
    } catch (error) {
      const failure = error as { code?: string; detail?: string; message?: string };
      invalid = { code: failure.code ?? 'session_read_failed', detail: failure.detail ?? failure.message ?? path };
    }
    const lastMode = events.filter((event) => event.kind === 'mode').at(-1);
    const label = foldLabel(events);
    const summary: SessionSummary = {
      id,
      formatVersion: header?.formatVersion ?? 0,
      projectRoot: ownRoot,
      // 同时返回工作区身份和来源，供界面分组；不根据当前默认目录推测历史归属。
      workspace: header?.workspace ?? '',
      workspaceOrigin: header?.workspaceOrigin ?? '',
      createdAt: header?.createdAt ?? null,
      updatedAt: info.mtime.toISOString(),
      events: events.length,
      lastSeq,
      mode: lastMode === undefined || typeof lastMode.name !== 'string'
        ? null
        : { name: lastMode.name, layer: String(lastMode.layer ?? ''), digest: String(lastMode.digest ?? '') },
      name: label.name,
      archived: label.archived,
      unanswered: findUnresolvedCalls(events).length,
      truncatedBytes,
      ...(invalid === undefined ? {} : { error: invalid }),
    };
    summaries.push(summary);
    fresh.set(id, { bytes: info.size, mtimeMs: info.mtimeMs, headerRoot: headerRoot ?? null, summary });
  }
  summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (index && (dirty || cache.entries.size !== fresh.size)) {
    await writeListIndex(directory, fresh);
  }
  return limit === undefined ? summaries : summaries.slice(0, limit);
}

/** Lists one workspace across its current and legacy locations without copying or repairing records. */
export async function listWorkspaceSessions(
  config: SessionDirectoryConfig,
  { projectRoot = config.workspaceRoot ?? config.boundary, limit = undefined as number | undefined } = {},
): Promise<SessionSummary[]> {
  const directories = sessionDirectories(config);
  // 索引只写入当前工作区的记录目录；旧目录保持只读发现。
  const groups = await Promise.all(directories.map((directory, position) => listSessions(directory, { projectRoot, index: position === 0 })));
  const records = new Map<string, SessionSummary>();
  for (const group of groups) {
    for (const item of group) if (!records.has(item.id)) records.set(item.id, item);
  }
  const sorted = [...records.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return limit === undefined ? sorted : sorted.slice(0, limit);
}
