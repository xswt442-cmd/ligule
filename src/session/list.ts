// 会话列表：从记录目录扫出来，不建索引也不建元数据表（D11、D73）。
// 一份记录能读出来的事都在这一处：它是哪一版格式、属于哪个项目、什么时候动过、几条事件、
// 最后生效的是哪一份模式清单，以及有没有还没收尾的派发（那是第 33 步那一条判据，列表里就该看得见）。
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { KernelError } from '../kernel/error.js';
import type { ModeFile } from '../kernel/modes.js';
import { workspaceIdentity } from '../kernel/workspace.js';
import { findUnresolvedCalls } from './repair.js';
import type { SessionEvent, SessionHeader } from './format.js';
import { foldLabel } from './format.js';
import { parseSessionBytes } from './record.js';

// 恢复一次会话该用哪一份模式清单：客户端指名了那一份就照它；没指名就用记录里最后生效的那一条，并比它的摘要（D78）。
// 名字对得上而摘要变了要报出来——静默换成磁盘上现在这一份，等于在别人没选过的范围里决定这一次能用什么。
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
  // 没有首行的记录（版本 0）里那条模式事件不带摘要，这一种只能比名字，名字对得上就沿用。
  if (recorded.digest !== undefined && recorded.digest !== loaded?.digest) {
    throw new KernelError('resume_mode_changed', {
      detail: `${recorded.name} was ${recorded.digest} in that session and is ${loaded?.digest ?? 'unreadable'} on disk; name a mode explicitly to resume`,
    });
  }
  return recorded.name;
}

export interface SessionDirectoryConfig {
  boundary: string;
  host?: { sessionDirectory?: unknown };
}

export interface SessionSummary {
  id: string;
  // 没有首行的现存记录读作版本 0（D73）。
  formatVersion: number;
  projectRoot: string;
  createdAt: string | null;
  updatedAt: string;
  events: number;
  lastSeq: number;
  mode: { name: string; layer: string; digest: string } | null;
  // 人给这一份会话起的名字；没起过就是空串，列表那一处拿会话编号当标题（实现顺序第 75 步）。
  name: string;
  // 归档只改列表怎么展示：记录还在，接得上，也能取消归档（方案 4.2）。
  archived: boolean;
  // 有几条派发留在记录里没有结果：恢复这一次会话时它们会被补成未知结果（D72）。
  unanswered: number;
  truncatedBytes: number;
  error?: { code: string; detail: string };
}

export function sessionDirectory(config: SessionDirectoryConfig): string {
  const configured = config.host?.sessionDirectory;
  if (typeof configured === 'string' && configured !== '') return configured;
  return join(config.boundary, '.ligule', 'sessions');
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
  // 筛的是同一个目录，不是同一串字符：记录头部写的是当时那一种写法，命令行上敲的可能是另一种大小写、分隔符或链接。
  // 字面相同就先认，不同的那一些才付一次归一（`realpath` 那一类同步调用）的钱。
  const asked = projectRoot === undefined ? undefined : resolve(projectRoot);
  const askedIdentity = asked === undefined ? undefined : workspaceIdentity(asked);
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    const path = join(directory, name);
    const bytes = await readFile(path);
    // 首行提供项目归属；损坏或不支持的记录仍保留一行带错误的列表项。
    let header: SessionHeader | undefined;
    try {
      const end = bytes.indexOf(0x0a);
      const first: unknown = JSON.parse(bytes.subarray(0, end < 0 ? 0 : end).toString('utf8'));
      if (first !== null && typeof first === 'object' && (first as { kind?: unknown }).kind === 'session') header = first as SessionHeader;
    } catch {
      // 正文与首行的错误由完整记录校验交回，不用猜测损坏记录的项目归属。
    }
    // 按项目根过滤时，读不出项目根的那些（没有首行的现存记录）不算在这个项目里：过滤的意义是「只显示这一处的会话」。
    if (asked !== undefined && typeof header?.projectRoot === 'string'
      && resolve(header.projectRoot) !== asked && workspaceIdentity(header.projectRoot) !== askedIdentity) continue;
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
    if (projectRoot !== undefined && invalid === undefined && header === undefined) continue;
    const lastMode = events.filter((event) => event.kind === 'mode').at(-1);
    const label = foldLabel(events);
    summaries.push({
      id,
      formatVersion: header?.formatVersion ?? 0,
      projectRoot: header?.projectRoot ?? '',
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
