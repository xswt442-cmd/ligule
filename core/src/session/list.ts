// 会话列表直接扫描记录目录，不构建索引或额外元数据表。
// 从每条记录读取格式版本、项目归属、更新时间、事件数、最后生效模式和未完成调用数量。
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { dataRoot } from '../kernel/config-file.js';
import { KernelError } from '../kernel/error.js';
import type { ModeFile } from '../kernel/modes.js';
import { workspaceIdentity } from '../kernel/workspace.js';
import { findUnresolvedCalls } from './repair.js';
import type { SessionEvent, SessionHeader } from './format.js';
import { foldLabel } from './format.js';
import { parseSessionBytes } from './record.js';

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

export interface SessionDirectoryConfig {
  boundary: string;
  // 返回数据根路径，与用户配置层使用同一目录。
  userHome?: string;
  host?: { sessionDirectory?: unknown };
}

export interface SessionSummary {
  id: string;
  // 缺少首行的旧记录按版本 0 解析。
  formatVersion: number;
  projectRoot: string;
  // 旧记录没有工作区来源字段时返回空值，表示来源未知，不表示默认工作区。
  workspace: string;
  workspaceOrigin: string;
  createdAt: string | null;
  updatedAt: string;
  events: number;
  lastSeq: number;
  mode: { name: string; layer: string; digest: string } | null;
  // 返回用户设置的会话名称；未命名时为空字符串，由列表显示会话编号。
  name: string;
  // 归档状态只影响列表展示；会话记录仍可恢复或取消归档。
  archived: boolean;
  // 返回已派发但尚无结果的调用数；恢复会话时这些调用会被标记为结果未知。
  unanswered: number;
  truncatedBytes: number;
  error?: { code: string; detail: string };
}

export function sessionDirectory(config: SessionDirectoryConfig): string {
  const configured = config.host?.sessionDirectory;
  if (typeof configured === 'string' && configured !== '') return configured;
  // 默认会话目录位于数据根中，与用户配置同根；项目文件边界不影响记录位置。
  return join(dataRoot(config.userHome), 'sessions');
}

function projectRootOfLegacyDirectory(directory: string): string | undefined {
  const resolved = resolve(directory);
  if (resolved === resolve(join(dataRoot(), 'sessions'))) return undefined;
  if (basename(resolved) !== 'sessions' || basename(dirname(resolved)) !== '.ligule') return undefined;
  return dirname(dirname(resolved));
}

export async function listSessions(
  directory: string,
  { projectRoot = undefined as string | undefined, limit = undefined as number | undefined } = {},
): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
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
    const headerRoot = typeof header?.projectRoot === 'string' && header.projectRoot !== '' ? header.projectRoot : undefined;
    if (asked !== undefined && headerRoot !== undefined
      && resolve(headerRoot) !== asked && workspaceIdentity(headerRoot) !== askedIdentity) continue;
    if (asked !== undefined && headerRoot === undefined
      && (physicalProjectRoot === undefined || physicalIdentity !== askedIdentity)) continue;
    // 没有首行的记录只按实际记录目录归属；数据根中归属未知的记录仅出现在未筛选列表。
    const ownRoot = headerRoot ?? physicalProjectRoot ?? '';
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
    summaries.push({
      id,
      formatVersion: header?.formatVersion ?? 0,
      projectRoot: ownRoot,
      // 同时返回工作区身份和来源，供界面分组；不根据当前默认目录推测历史归属。
      workspace: header?.workspace ?? '',
      workspaceOrigin: header?.workspaceOrigin ?? '',
      createdAt: header?.createdAt ?? null,
      updatedAt: (await stat(path)).mtime.toISOString(),
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
    });
  }
  summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return limit === undefined ? summaries : summaries.slice(0, limit);
}
