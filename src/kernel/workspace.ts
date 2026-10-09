// 工作区的身份与那份持久登记（D110、方案 5.5.1 与 5.5.2）。
// 身份是「哪一个目录」，不是「哪一串字符」：Windows 上同一个目录可以有大小写、分隔符、盘符、尾部斜杠与链接多种写法，
// 登记、缓存与筛选都按归一之后的那一个值比，别名不会各占一条。
// 清单存在应用数据根里，界面上那一栏只是它的一个读者：侧栏收起或列不出来都不该让一个工作区从登记里消失。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { dataRoot } from './config-file.js';
import { KernelError } from './error.js';

export const REGISTRY_VERSION = 1;

export type WorkspaceEntry = {
  identity: string;
  directory: string;
  name: string;
  firstSeen: string;
  lastSeen: string;
};

export type WorkspaceRegistry = {
  version: number;
  default: string | null;
  workspaces: WorkspaceEntry[];
};

/** 归一出一个目录的可比写法。目录不存在或读不动时用解析出来的那一条路：这一处不判存在性，那是装载那一步的事。 */
function canonicalOf(directory: string): { identity: string; directory: string } {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new KernelError('workspace_directory_required', { detail: String(directory) });
  }
  const asked = resolve(directory);
  let real = asked;
  try {
    real = realpathSync(asked);
  } catch {
    real = asked;
  }
  if (process.platform === 'win32') {
    const stripped = real.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
    const rooted = /^[A-Za-z]:$/.test(stripped) ? `${stripped}\\` : stripped;
    // 盘符大小写与整条路的大小写都不参与身份：那台机器上它们指的是同一个目录。
    return { identity: rooted.toLowerCase(), directory: rooted };
  }
  const rooted = real.replace(/\/+$/, '');
  return { identity: rooted === '' ? '/' : rooted, directory: rooted };
}

/** 那一个目录的身份值：登记、缓存与记录筛选共用的那一个键。 */
export function workspaceIdentity(directory: string): string {
  return canonicalOf(directory).identity;
}

export function registryPathOf(home = homedir()): string {
  return join(dataRoot(home), 'workspaces.json');
}

export function emptyRegistry(): WorkspaceRegistry {
  return { version: REGISTRY_VERSION, default: null, workspaces: [] };
}

function checkedEntry(value: unknown): WorkspaceEntry {
  const entry = value as Partial<WorkspaceEntry>;
  const fields = ['identity', 'directory', 'name', 'firstSeen', 'lastSeen'] as const;
  const missing = fields.filter((one) => typeof entry?.[one] !== 'string' || entry[one] === '');
  if (missing.length > 0) throw new KernelError('workspace_registry_invalid', { detail: `entry is missing ${missing.join(', ')}` });
  return {
    identity: entry.identity as string,
    directory: entry.directory as string,
    name: entry.name as string,
    firstSeen: entry.firstSeen as string,
    lastSeen: entry.lastSeen as string,
  };
}

/** 读那份登记：文件不在就是空的一份，读不懂或形状不对当场拒掉——静默当成空的等于把人的工作区清单丢了。 */
export function parseRegistry(text: string): WorkspaceRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new KernelError('workspace_registry_invalid', { detail: 'the file is not JSON' });
  }
  const registry = parsed as Partial<WorkspaceRegistry>;
  if (registry === null || typeof registry !== 'object' || !Array.isArray(registry.workspaces)) {
    throw new KernelError('workspace_registry_invalid', { detail: 'the file is not that table' });
  }
  if (registry.version !== REGISTRY_VERSION) {
    throw new KernelError('workspace_registry_version', { detail: `file says ${String(registry.version)}, this build reads ${REGISTRY_VERSION}` });
  }
  const workspaces = registry.workspaces.map(checkedEntry);
  const wanted = new Set(workspaces.map((one) => one.identity));
  const chosen = registry.default === null || registry.default === undefined ? null : registry.default;
  if (chosen !== null && !wanted.has(chosen)) {
    throw new KernelError('workspace_registry_invalid', { detail: `the default ${chosen} is not registered` });
  }
  return { version: REGISTRY_VERSION, default: chosen, workspaces };
}

export async function readRegistry(path = registryPathOf()): Promise<WorkspaceRegistry> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return emptyRegistry();
    throw error;
  }
  return parseRegistry(text);
}

let writing: Promise<unknown> = Promise.resolve();

/**
 * 记下这一次用到的工作区：一个身份只有一条，`firstSeen` 留着，`lastSeen` 与显示名跟着这一次走。
 * 同进程里连着登记两次排成一条队，改名时不留半份文件。
 */
export function registerWorkspace(directory: string, { path = registryPathOf(), name = undefined as string | undefined, now = new Date().toISOString() } = {}): Promise<WorkspaceRegistry> {
  const canonical = canonicalOf(directory);
  const next = writing.then(async () => {
    const registry = await readRegistry(path);
    const known = registry.workspaces.find((one) => one.identity === canonical.identity);
    if (known === undefined) {
      registry.workspaces.push({
        identity: canonical.identity,
        directory: canonical.directory,
        name: name === undefined || name.trim() === '' ? basename(canonical.directory) : name.trim(),
        firstSeen: now,
        lastSeen: now,
      });
    } else {
      known.lastSeen = now;
      known.directory = canonical.directory;
      if (name !== undefined && name.trim() !== '') known.name = name.trim();
    }
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
    return registry;
  });
  writing = next.catch(() => undefined);
  return next;
}

/** 等那一条登记队列走完：检查里要用它确认落盘。 */
export function flushRegistry(): Promise<unknown> {
  return writing;
}
