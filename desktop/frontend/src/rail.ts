// 左侧栏那一份分组规则（方案 5.5.4）：只有创建时指名了工作区的会话在上面成组，其余的在下面直接排列。
// 归组读的是记录首行那两格（身份与来源），不是「这条路径等不等于现在的默认目录」：默认目录换了，旧的会话不挪位置。
import type { SessionSummary } from './components/SessionRail';

/** 一条路经的最后那一段：Windows 与 POSIX 的分隔符都算。 */
function leafOf(path: string): string {
  const parts = path.split(/[\\/]+/).filter((one) => one !== '');
  return parts.length === 0 ? path : parts[parts.length - 1];
}

export type WorkspaceRow = { identity: string; directory: string; name: string };

/** 那份持久登记的形状（方案 5.5.1）：`workspaces.list` 交回的就是这一份，默认那一格指的是 `identity`。 */
export type WorkspaceRoster = { default: string | null; workspaces: WorkspaceRow[] };

export type RailGroup = {
  identity: string;
  root: string;
  label: string;
  // 登记里那一格默认选择指的就是这一组（方案 5.5.1）：由 `workspaces.list` 交回，界面不自己记。
  isDefault: boolean;
  sessions: SessionSummary[];
};

export type RailLayout = { groups: RailGroup[]; loose: SessionSummary[] };

/** 归档的沉到本组底下，其余按宿主给的回读顺序（宿主已按最近动过排序）。 */
function withinGroup(items: SessionSummary[]): SessionSummary[] {
  return [...items].sort((left, right) => Number(left.archived === true) - Number(right.archived === true));
}

/**
 * 分组：`workspaceOrigin === 'explicit'` 的按 `workspace` 身份成组；其余进 `loose`。
 * `watched` 是这一扇窗口另外指着的那几项目录——还没有会话的那几份也要有自己那一组，人才能在它里面新建。
 * `registry` 是那份持久登记：组名与目录优先取登记里的那一行，人改过显示名就不用目录那一段（方案 5.5.1）。
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
    // 身份那一格是归组的键；首行没写身份的记录（更早的版本）用它的目录当键，位置仍由来源那一格决定。
    const root = item.projectRoot === '' ? item.workspace ?? '' : item.projectRoot;
    add(item.workspace ?? root, root, item);
  }
  for (const root of watched) {
    if (root === '') continue;
    // 那一具工作区在登记里有一行时，身份取那一行：记录首行里写的是内核折过的身份，两边同一把键才不会被拆成两组。
    const identity = registry.workspaces.find((one) => one.directory === root)?.identity
      ?? sessions.find((item) => item.projectRoot === root)?.workspace
      ?? root;
    add(identity, root);
  }
  const newest = (group: RailGroup): string => group.sessions.map((item) => item.updatedAt).sort().at(-1) ?? '';
  return {
    groups: [...groups.values()].map((group) => ({ ...group, sessions: withinGroup(group.sessions) }))
      .sort((left, right) => newest(right).localeCompare(newest(left))),
    loose: withinGroup(loose),
  };
}

/**
 * 侧栏看得见的那几项目录（审阅 F3）：那份持久登记是主要来源，窗口另外指着的那几份跟着一起扫。
 * 只按窗口那一份清单走的话，终端界面登记的非默认工作区里的记录列不出来——登记存在不等于找得回来。
 * 第一项固定是 `''`：那一个不指名，读的是这一具宿主自己的项目环境。
 */
export function visibleRoots(registry: WorkspaceRoster, watched: string[]): string[] {
  const out = [''];
  const seen = new Set<string>();
  for (const root of [...watched, ...registry.workspaces.map((one) => one.directory)]) {
    const key = root.replace(/[/\\]+$/, '').toLowerCase();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

/**
 * 新建一份会话要递出去的那一格（方案 5.5.3）：人选的那一具算 `explicit`，界面自己退出来的那一份算 `default`，
 * 三格都没有就不指名，由宿主用它自己那一份项目环境。
 */
export function createCallOf(named: string | undefined, current: string | undefined, fallback: string | undefined): { projectRoot?: string; workspaceOrigin?: 'explicit' | 'default' } {
  const asked = named ?? current ?? fallback;
  if (asked === undefined) return {};
  return { projectRoot: asked, workspaceOrigin: named === undefined ? 'default' : 'explicit' };
}
