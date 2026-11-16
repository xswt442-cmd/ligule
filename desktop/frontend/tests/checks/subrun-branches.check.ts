import assert from 'node:assert/strict';
import { subrunBranchOf } from '../../src/subrun-branches.ts';

const child = subrunBranchOf({
  seq: 7,
  kind: 'tool',
  tool: 'subagent_start',
  runId: 'parent-run',
  args: { task: 'inspect one file' },
  result: { content: { subrunId: 'parent.sub-1', sessionId: 'parent.sub-1', runId: 'child-run' } },
});
assert.deepEqual(child, {
  seq: 7,
  id: 'parent.sub-1',
  task: 'inspect one file',
  reference: { parentRunId: 'parent-run', subrunId: 'parent.sub-1', runId: 'child-run' },
});
assert.deepEqual(subrunBranchOf({
  seq: 8, kind: 'tool', tool: 'subagent', args: { task: 'legacy' }, result: { content: { sessionId: 'parent.sub-2' } },
}), { seq: 8, id: 'parent.sub-2', task: 'legacy' }, 'legacy waiting subtasks remain viewable');
assert.equal(subrunBranchOf({ seq: 9, kind: 'tool', tool: 'read', result: { content: { sessionId: 'unrelated' } } }), null);
assert.equal(subrunBranchOf({ seq: 10, kind: 'tool', tool: 'subagent_start', result: { content: 'spilled' } }), null);

console.log('子任务会话引用检查通过');
