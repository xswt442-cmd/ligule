import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { dataRoot } from './data-root.js';
import { workspaceIdentity } from './workspace-identity.js';

export interface SessionDirectoryConfig {
  boundary: string;
  workspaceRoot?: string;
  // 返回数据根路径，与用户配置层使用同一目录。
  userHome?: string;
  host?: { sessionDirectory?: unknown };
}

export function sessionDirectory(config: SessionDirectoryConfig): string {
  const configured = config.host?.sessionDirectory;
  if (typeof configured === 'string' && configured !== '') return configured;
  return join(workspaceDataDirectory(config), 'sessions');
}

export function workspaceDataDirectory(config: SessionDirectoryConfig): string {
  const workspace = config.workspaceRoot ?? config.boundary;
  const identity = workspaceIdentity(workspace);
  const prettyPath = workspaceFolderLabel(identity);
  const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return join(dataRoot(config.userHome), 'workspaces', `${prettyPath}--${suffix}`);
}

function workspaceFolderLabel(identity: string): string {
  const windowsDrive = /^([a-z]):[\\/]/i.exec(identity);
  if (windowsDrive !== null) {
    const parts = identity.slice(windowsDrive[0].length).split(/[\\/]+/u).filter(Boolean);
    return `${windowsDrive[1].toLowerCase()}--${parts.map(safePathPart).join('-')}`.slice(0, 120);
  }
  const unc = splitUncIdentity(identity);
  if (unc !== undefined) {
    const parts = [unc.host, ...unc.rest.split(/[\\/]+/u)].filter(Boolean);
    return `unc--${parts.map(safePathPart).join('-')}`.slice(0, 120);
  }
  const parts = identity.split(/[\\/]+/u).filter(Boolean);
  return `root-${parts.map(safePathPart).join('-')}`.slice(0, 120);
}

/**
 * 把 `\\host\share\x` 拆成 host 与其余部分；不是 UNC 路径时返回 undefined。
 *
 * 逐字符扫描而不是用 `/^\\\\([^\\]+)[\\/]+(.+)$/u`：后者两个量词共享分隔符，
 * 每个字符位置的失败路径都要重扫分隔符串，输入由路径决定会退化成多项式时间
 * （CodeQL js/polynomial-redos）。这里按正则的贪婪顺序取最靠右的可行切分：
 * `(.+)` 贪婪使剩余部分尽量短，因此 host 取最长的可行前缀；复杂度与路径长度线性相关。
 */
export function splitUncIdentity(identity: string): { host: string; rest: string } | undefined {
  if (!identity.startsWith('\\\\')) return undefined;
  const body = identity.slice(2);
  const length = body.length;
  const isSeparator = (char: string): boolean => char === '/' || char === '\\';
  // 组 1 不含反斜杠：第一次出现的位置固定后，每个候选只用比较下标，不必重扫前缀。
  const firstBackslash = body.indexOf('\\');
  // 组 3 用 `.` 且 `$`：JS 里不带 m 的 `$` 只匹配输入末尾，所以其余部分不能含换行。
  const newlinesAfter = new Int32Array(length + 1);
  for (let index = length - 1; index >= 0; index -= 1) {
    newlinesAfter[index] = newlinesAfter[index + 1] + (body[index] === '\n' ? 1 : 0);
  }
  for (let restStart = length - 1; restStart >= 1; restStart -= 1) {
    const hostEnd = restStart - 1;
    if (!isSeparator(body[hostEnd]) || hostEnd === 0) continue;
    if (firstBackslash !== -1 && hostEnd > firstBackslash) continue;
    if (newlinesAfter[restStart] > 0) continue;
    const rest = body.slice(restStart);
    if (rest === '') continue;
    return { host: body.slice(0, hostEnd), rest };
  }
  return undefined;
}

function safePathPart(part: string): string {
  return part.replace(/[^\p{L}\p{N}_-]/gu, '-');
}

/** Existing paths are read for discovery; writes happen only when a user opens a legacy session. */
export function sessionDirectories(config: SessionDirectoryConfig): string[] {
  const configured = config.host?.sessionDirectory;
  const primary = sessionDirectory(config);
  if (typeof configured === 'string' && configured !== '') return [primary];
  const workspace = config.workspaceRoot ?? config.boundary;
  const candidates = [
    join(dataRoot(config.userHome), 'sessions'),
    join(workspace, '.ligule', 'sessions'),
  ];
  const seen = new Set([pathIdentity(primary)]);
  return [primary, ...candidates.filter((candidate) => {
    const identity = pathIdentity(candidate);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  })];
}

function pathIdentity(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
