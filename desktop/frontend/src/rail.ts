// 左侧栏那一份分组规则（方案 5.5.4）：只有创建时指名了工作区的会话在上面成组，其余的在下面直接排列。
// 归组读的是记录首行那两格（身份与来源），不是「这条路径等不等于现在的默认目录」：默认目录换了，旧的会话不挪位置。
import type { SessionSummary } from './components/SessionRail';

/** 一条路经的最后那一段：Windows 与 POSIX 的分隔符都算。 */
function leafOf(path: string): string {
  const parts = path.split(/[\\/]+/).filter((one) => one !== '');
  return parts.length === 0 ? path : parts[parts.length - 1];
}

export type RailGroup = {
  identity: string;
  root: string;
  label: string;
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
 */
export function groupByWorkspace(sessions: SessionSummary[], watched: string[] = []): RailLayout {
  const groups = new Map<string, RailGroup>();
  const loose: SessionSummary[] = [];
  const add = (identity: string, root: string, item?: SessionSummary) => {
    const known = groups.get(identity);
    if (known === undefined) groups.set(identity, { identity, root, label: leafOf(root), sessions: item === undefined ? [] : [item] });
    else if (item !== undefined) known.sessions.push(item);
    return known;
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
    const identity = sessions.find((item) => item.projectRoot === root)?.workspace ?? root;
    add(identity, root);
  }
  const newest = (group: RailGroup): string => group.sessions.map((item) => item.updatedAt).sort().at(-1) ?? '';
  return {
    groups: [...groups.values()].map((group) => ({ ...group, sessions: withinGroup(group.sessions) }))
      .sort((left, right) => newest(right).localeCompare(newest(left))),
    loose: withinGroup(loose),
  };
}
