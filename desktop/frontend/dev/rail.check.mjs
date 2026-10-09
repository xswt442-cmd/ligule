// 左侧栏那一份分组规则的唯一检查：跑 `node dev/rail.check.mjs`，坏了就非零退出（方案 5.5.4）。
import assert from 'node:assert/strict';
import { groupByWorkspace } from '../src/rail.ts';

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

console.log('左侧栏的分组检查通过');
