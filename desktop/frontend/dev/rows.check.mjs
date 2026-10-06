// 投影那一份取值规则的唯一检查：跑 `node dev/rows.check.mjs`，坏了就非零退出。
// 它 import 的是同目录树上那份 `src/rows.ts`，Node 直接剥类型跑，不需要构建产物。
import assert from 'node:assert/strict';
import { capabilityOf, projectRecord } from '../src/rows.ts';

const call = projectRecord({
  kind: 'assistant',
  text: '',
  toolCalls: [{ id: 'c1', name: 'mcp.call', args: { server: 'demo', tool: 'lookup', input: { key: 'x' } } }],
})[0];
assert.equal(call.tool, 'mcp:demo/lookup');
assert.equal(call.summary, '{"input":{"key":"x"}}');
assert.match(call.text, /"server": "demo"/);

assert.equal(capabilityOf('exec', { command: 'git status' }), 'exec');

const write = projectRecord({
  kind: 'tool',
  tool: 'write',
  callId: 'c2',
  args: { path: 'notes/readings.md', content: '# 读数\n\n窗口 200000\n' },
  verdict: { decision: 'allow', via: 'auto', capability: 'write', level: 'auto' },
  result: { content: { text: '写了 3 行' } },
})[0];
assert.equal(write.kind, 'result');
assert.equal(write.summary, 'notes/readings.md：4 行新内容');
assert.deepEqual(write.diff, { removed: 0, added: 4 });
assert.deepEqual(write.notes, ['判定没问就放行（auto）']);
assert.equal(write.text, '写了 3 行');

const edit = projectRecord({
  kind: 'tool',
  tool: 'edit',
  callId: 'c7',
  args: { path: 'notes/readings.md', anchor: '旧的一行\n第二行', replacement: '新的一句话\n第二行\n第三行' },
  result: { content: { text: '换好了' } },
})[0];
assert.equal(edit.summary, 'notes/readings.md：换掉 2 行，换上 3 行');
assert.deepEqual(edit.diff, { removed: 2, added: 3 });

const failure = projectRecord({
  kind: 'tool',
  tool: 'exec',
  callId: 'c3',
  args: { command: 'node -e 1' },
  verdict: { decision: 'allow', via: 'ask', capability: 'exec', level: 'ask', rule: '命令逐次询问' },
  result: { failed: true, code: 'exec_exit_1', content: { text: '命令没找到', exitCode: 1 }, spilled: 'result-3-1a2b3c4d.json' },
}, { startedAt: Date.now() - 2500 })[0];
assert.equal(failure.kind, 'failure');
assert.equal(failure.code, 'exec_exit_1');
assert.equal(failure.text, '命令没找到');
assert.equal(failure.notes.length, 4);
assert.deepEqual(failure.notes.slice(0, 3), ['退出码 1', '整段在 result-3-1a2b3c4d.json', '判定问过才放行（ask） 规则「命令逐次询问」']);
assert.match(failure.notes[3], /^用时 2\.\d 秒$/);

const refusal = projectRecord({
  kind: 'tool',
  tool: 'exec',
  callId: 'c4',
  args: { command: 'rm -rf .' },
  verdict: { decision: 'deny', via: 'ask', capability: 'exec', level: 'auto', forced: true },
  result: { failed: true, kind: 'refusal', code: 'policy_denied', reason: '这一条没被允许。' },
})[0];
assert.equal(refusal.kind, 'refusal');
assert.equal(refusal.text, '这一条没被允许。');
assert.deepEqual(refusal.notes, ['判定没让做（auto→ask）']);

const repaired = projectRecord({
  kind: 'tool',
  tool: 'exec',
  callId: 'c5',
  args: { command: 'git status --short' },
  recovery: { assistantSeq: 14, safeToRedo: false },
  result: { failed: true, code: 'tool_outcome_unknown', content: { text: '那一次派发没留下结果。' } },
})[0];
assert.equal(repaired.code, 'tool_outcome_unknown');
assert.deepEqual(repaired.notes, ['恢复补的 · 外部副作用次数未知']);

// 没有参数的那一次调用不该在正文里留一个空对象；读不认识的种类不产行。
assert.equal(projectRecord({ kind: 'assistant', text: '', toolCalls: [{ id: 'c6', name: 'skill' }] })[0].text, '');
assert.deepEqual(projectRecord({ kind: 'usage', input: 1 }), []);
console.log('桌面前端的投影检查通过');
