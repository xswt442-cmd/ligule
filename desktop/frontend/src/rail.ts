// 左侧栏只将创建时明确指定工作区的会话分组；其他会话直接列出。
// 分组依据是记录首行保存的工作区身份和来源，不随默认目录变化而移动旧会话。
import type { SessionSummary } from './components/rail/types';
import { code, type Client } from './protocol.ts';

/** 返回路径末尾的目录名，兼容 Windows 和 POSIX 分隔符。 */
function leafOf(path: string): string {
  const parts = path.split(/[\\/]+/).filter((one) => one !== '');
  return parts.length === 0 ? path : parts[parts.length - 1];
}

export type WorkspaceRow = { identity: string; directory: string; name: string };

/** `workspaces.list` 返回的持久工作区登记结构；默认工作区通过 `identity` 标识。 */
export type WorkspaceRoster = { default: string | null; workspaces: WorkspaceRow[] };

export type WorkspaceSessionsPage = { root: string; sessions: SessionSummary[]; failed: string };

export async function loadWorkspacePages(roots: string[], client: Pick<Client, 'call'>): Promise<WorkspaceSessionsPage[]> {
  const pages = new Array<WorkspaceSessionsPage>(roots.length);
  let next = 0;
  const readNext = async () => {
    while (next < roots.length) {
      const index = next++;
      const root = roots[index];
      try {
        const result = await client.call('sessions.list', root === '' ? {} : { projectRoot: root }, 60_000) as { sessions: SessionSummary[] };
        pages[index] = { root, sessions: result.sessions, failed: '' };
      } catch (error) {
        pages[index] = { root, sessions: [], failed: code(error) };
      }
    }
  };
  const workers = Math.min(8, roots.length);
  await Promise.all(Array.from({ length: workers }, () => readNext()));
  return pages;
}

export type RailGroup = {
  identity: string;
  root: string;
  label: string;
  // 默认工作区身份由 `workspaces.list` 返回，界面不单独保存。
  isDefault: boolean;
  sessions: SessionSummary[];
};

export type RailLayout = { groups: RailGroup[]; loose: SessionSummary[] };

/** 将已归档会话排在组内末尾，其余会话保持 Host 按最近活动排序后的顺序。 */
function withinGroup(items: SessionSummary[]): SessionSummary[] {
  return [...items].sort((left, right) => Number(left.archived === true) - Number(right.archived === true));
}

/**
 * 将 `workspaceOrigin === 'explicit'` 的会话按 `workspace` 身份分组，其余放入 `loose`。
 * `watched` 包含窗口中额外关注的目录，即使目录还没有会话也要显示，便于从中创建会话。
 * `registry` 是持久工作区登记表；优先使用登记中的自定义名称，没有名称时使用目录名。
 */
export function groupByWorkspace(sessions: SessionSummary[], watched: string[] = [], registry: WorkspaceRoster = { default: null, workspaces: [] }): RailLayout {
  const groups = new Map<string, RailGroup>();
  const loose: SessionSummary[] = [];
  const rowOf = (identity: string, root: string) => registry.workspaces.find((one) => one.identity === identity || one.directory === root);
  const add = (identity: string, root: string, item?: SessionSummary) => {
    const known = groups.get(identity);
    if (known === undefined) {
      const row = rowOf(identity, root);
      const where = row?.directory ?? root;
      groups.set(identity, { identity, root: where, label: row?.name ?? leafOf(where), isDefault: registry.default === identity, sessions: item === undefined ? [] : [item] });
    } else if (item !== undefined) known.sessions.push(item);
  };
  for (const item of sessions) {
    if (item.workspaceOrigin !== 'explicit') {
      loose.push(item);
      continue;
    }
    // 使用工作区身份分组；旧记录没有身份时以目录作为分组键，来源仍由首行元数据决定。
    const root = item.projectRoot === '' ? item.workspace ?? '' : item.projectRoot;
    add(item.workspace ?? root, root, item);
  }
  for (const root of watched) {
    if (root === '') continue;
    // 工作区已登记时使用登记中的身份，与记录首行的归一化身份保持一致。
    const identity = registry.workspaces.find((one) => one.directory === root)?.identity
      ?? sessions.find((item) => item.projectRoot === root)?.workspace
      ?? root;
    add(identity, root);
  }
  const newest = (group: RailGroup): string => group.sessions.map((item) => item.updatedAt).sort().at(-1) ?? '';
  return {
    groups: [...groups.values()].map((group) => ({ ...group, sessions: withinGroup(group.sessions) }))
      .sort((left, right) => Number(left.isDefault) - Number(right.isDefault)
        || newest(right).localeCompare(newest(left))),
    loose: withinGroup(loose),
  };
}

/**
 * 返回侧栏可展示的工作区，优先使用持久登记，并合并窗口额外关注的目录。
 * 仅使用窗口目录会漏掉由 TUI 登记的非默认工作区。
 * 第一项固定为 `''`，表示 Host 的默认项目环境。
 */
export function visibleRoots(registry: WorkspaceRoster, watched: string[]): string[] {
  const out = [''];
  const seen = new Set<string>();
  for (const root of [...watched, ...registry.workspaces.map((one) => one.directory)]) {
    const key = root.replace(/[/\\]+$/, '') || root;
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

/**
 * 构造新会话的工作区来源：用户选择的目录为 `explicit`，界面提供的默认目录为 `default`。
 * 两者都没有时不指定项目，由 Host 使用默认环境。
 */
export function createCallOf(named: string | undefined, current: string | undefined, fallback: string | undefined): { projectRoot?: string; workspaceOrigin?: 'explicit' | 'default' } {
  const asked = named ?? current ?? fallback;
  if (asked === undefined) return {};
  return { projectRoot: asked, workspaceOrigin: named === undefined ? 'default' : 'explicit' };
}
