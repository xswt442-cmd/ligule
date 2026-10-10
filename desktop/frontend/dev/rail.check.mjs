// 左侧栏那一份分组规则的唯一检查：跑 `node dev/rail.check.mjs`，坏了就非零退出（方案 5.5.4）。
import assert from 'node:assert/strict';
import { createCallOf, groupByWorkspace, visibleRoots } from '../src/rail.ts';

const base = {
  formatVersion: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  events: 1,
  lastSeq: 0,
  mode: null,
  name: '',
  unanswered: 0,
  truncatedBytes: 0,
};
const session = (id, extra) => ({ id, projectRoot: '', updatedAt: '2026-10-01T00:00:00.000Z', ...base, ...extra });

const layout = groupByWorkspace([
  session('a', { projectRoot: 'E:\\work\\alpha', workspace: 'e:\\work\\alpha', workspaceOrigin: 'explicit', updatedAt: '2026-10-05T00:00:00.000Z' }),
  session('b', { projectRoot: 'E:/work/alpha', workspace: 'e:\\work\\alpha', workspaceOrigin: 'explicit', updatedAt: '2026-10-04T00:00:00.000Z', archived: true }),
  session('c', { projectRoot: 'E:\\work\\beta', workspace: 'e:\\work\\beta', workspaceOrigin: 'default', updatedAt: '2026-10-09T00:00:00.000Z' }),
  session('d', { projectRoot: 'E:\\work\\beta', updatedAt: '2026-10-08T00:00:00.000Z' }),
], ['E:\\work\\gamma']);

assert.deepEqual(layout.groups.map((one) => one.identity), ['e:\\work\\alpha', 'E:\\work\\gamma'], '只有指名过的工作区在上面成组，最近动过的那一组排在前面');
assert.deepEqual(layout.groups[0].sessions.map((one) => one.id), ['a', 'b'], '同一身份的两种路径写法共用一组，归档的沉到本组底下');
assert.equal(layout.groups[0].label, 'alpha', '组名是那一段目录名');
assert.equal(layout.groups[0].root, 'E:\\work\\alpha', '完整路径留在组上，画在提示里');
assert.deepEqual(layout.groups[1].sessions, [], '这一扇窗口另外指着的那份工作区还没有会话也要有自己那一组');
assert.deepEqual(layout.loose.map((one) => one.id), ['c', 'd'], '没指名工作区的与更早的记录直接排在下面，来源为 default 的也不成组');

// 首行没写身份、只写了目录的那一份：按目录成组，位置仍由来源那一格决定。
const keyed = groupByWorkspace([session('e', { projectRoot: '/srv/delta', workspaceOrigin: 'explicit' })]);
assert.equal(keyed.groups.length, 1);
assert.equal(keyed.groups[0].identity, '/srv/delta');
assert.equal(keyed.loose.length, 0);

// 空清单不造假的一组。
assert.deepEqual(groupByWorkspace([]), { groups: [], loose: [] });

// 那份持久登记是组名与「默认」那一枚标签的来源（方案 5.5.1）：登记里改过的显示名顶上，默认那一格指着的带标签。
const alpha = { identity: 'e:\\work\\alpha', directory: 'E:\\work\\alpha', name: '改过的名字', firstSeen: '2026-10-01T00:00:00.000Z', lastSeen: '2026-10-09T00:00:00.000Z' };
const explicit = session('a', { projectRoot: 'E:\\work\\alpha', workspace: 'e:\\work\\alpha', workspaceOrigin: 'explicit' });
const named = groupByWorkspace([explicit], [], { default: 'e:\\work\\alpha', workspaces: [alpha] });
assert.equal(named.groups[0].label, '改过的名字', '组名读登记里那一行的显示名，不再取目录那一段');
assert.equal(named.groups[0].isDefault, true, '默认那一格指着谁，谁就带那一枚标签');
assert.equal(groupByWorkspace([explicit], [], { default: null, workspaces: [alpha] }).groups[0].isDefault, false, '没有默认那一格时哪一组都不带标签');

// 登记记着的位置与记录里的路径写法不同：组上那份目录取登记里最后记下的一处（方案 5.5.1）。
const moved = groupByWorkspace([session('b', { projectRoot: 'E:\\work\\beta', workspace: 'e:\\work\\beta', workspaceOrigin: 'explicit' })], [],
  { default: null, workspaces: [{ identity: 'e:\\work\\beta', directory: 'E:/work/beta', name: 'beta', firstSeen: '', lastSeen: '' }] });
assert.equal(moved.groups[0].root, 'E:/work/beta', '在那一具工作区里新建时递出去的是登记里记着的那一处');
assert.equal(moved.groups[0].label, 'beta', '显示名也在登记那一行里');

// 新建会话要递出去的那一格：人选的算 explicit，界面退出来的那一份算 default，三格都没有就不指名（方案 5.5.3）。
assert.deepEqual(createCallOf('E:/work/alpha', 'E:/work/beta', 'E:/work/gamma'), { projectRoot: 'E:/work/alpha', workspaceOrigin: 'explicit' }, '人选的那一具优先');
assert.deepEqual(createCallOf(undefined, 'E:/work/beta', 'E:/work/gamma'), { projectRoot: 'E:/work/beta', workspaceOrigin: 'default' }, '眼前这一份会话所在的项目是界面退出来的');
assert.deepEqual(createCallOf(undefined, undefined, 'E:/work/gamma'), { projectRoot: 'E:/work/gamma', workspaceOrigin: 'default' }, '登记里的默认那一具也是退出来的，不是人选的');
assert.deepEqual(createCallOf(undefined, undefined, undefined), {}, '三格都没有时不指名，由宿主用它自己那一份项目环境');

// 那份持久登记决定侧栏看得见哪几项目录（审阅 F3）：终端界面登记的非默认工作区，这一扇窗口没指着它也要扫一遍。
const roster = {
  default: 'e:\\work\\beta',
  workspaces: [alpha, { identity: 'e:\\work\\beta', directory: 'E:\\work\\beta', name: 'beta', firstSeen: '', lastSeen: '' }],
};
assert.deepEqual(visibleRoots(roster, ['E:\\work\\gamma']), ['', 'E:\\work\\gamma', 'E:\\work\\alpha', 'E:\\work\\beta'], '第一项是不指名的宿主自己那一份，其余是窗口那几份加登记里那几份');
assert.deepEqual(visibleRoots(roster, ['E:\\work\\alpha', 'E:\\work\\alpha\\', '']), ['', 'E:\\work\\alpha', 'E:\\work\\beta'], '同一路径的两种写法与尾部分隔符只占一格，空的那一格不进清单');
assert.deepEqual(
  groupByWorkspace([session('f', { projectRoot: 'E:\\work\\beta', workspace: 'e:\\work\\beta', workspaceOrigin: 'explicit' })], visibleRoots(roster, []), roster).groups.map((one) => one.identity),
  ['e:\\work\\beta', 'e:\\work\\alpha'],
  '登记里每一具工作区都有自己的组，窗口没指着它也一样：还没有会话的那一组排后面，人能在那里面新建',
);

console.log('左侧栏的分组检查通过');
