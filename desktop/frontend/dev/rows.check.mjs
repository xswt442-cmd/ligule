// 投影那一份取值规则的唯一检查：跑 `node dev/rows.check.mjs`，坏了就非零退出。
// 它 import 的是同目录树上那份 `src/rows.ts`，Node 直接剥类型跑，不需要构建产物。
import assert from 'node:assert/strict';
import { capabilityOf, changeBody, changeOf, metaRow, projectRecord, questionEcho, shownIn } from '../src/rows.ts';

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
assert.equal(write.summary, 'notes/readings.md：整份写入 4 行');
assert.deepEqual(write.diff, { removed: 0, added: 4 });
// 审批那一格展开的两段内容都来自参数：整份写入没有一份读过的原文可画，编辑才有（方案 5.4）。
const writeChange = changeOf('write', { path: 'notes/readings.md', content: 'a\nb' });
assert.match(changeBody(writeChange, { content: 'a\nb' }), /^整份写入/);
assert.ok(!changeBody(writeChange, { content: 'a\nb' }).includes('要去掉的那一段'), '没读过的原文不编造');
assert.equal(
  changeBody(changeOf('edit', { path: 'x.md', anchor: '旧的一行', replacement: '新的一行' }), {}),
  'x.md：把定位到的那一段换成另一段\n要去掉的那一段:\n- 旧的一行\n要换上的那一段:\n+ 新的一行',
);
assert.equal(changeBody(changeOf('delete', { path: 'x.md' }), {}), '把 x.md 移进回收站（不是就地删掉：有回收站的地方进回收站，否则进边界内那一个回收目录）');
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

// 记录里带着内核量的那一格时画的是它：重开这份会话也还在，不靠界面活着的那一段（第 66 步）。
const recorded = projectRecord({
  kind: 'tool', tool: 'exec', callId: 'c5', args: { command: 'npm test' }, durationMs: 640,
  result: { failed: false, content: { text: 'ok' } },
}, { startedAt: Date.now() - 2500 })[0];
assert.deepEqual(recorded.notes, ['用时 0.6 秒']);

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
assert.deepEqual(refusal.notes, ['判定不允许（auto→ask）']);

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

// 每一行带着它来自哪一条事件：查找的命中说的是那一个序号，跳到那一行要靠它（方案 4.2、实现顺序第 77 步）。
const stamped = projectRecord({ seq: 12, kind: 'assistant', text: '两句', toolCalls: [{ id: 'c9', name: 'read', args: {} }] });
assert.deepEqual(stamped.map((row) => row.seq), [12, 12], '一条记录出来的每一行都认得自己是哪一条事件');
assert.equal(metaRow('meta', '界面自己写的一行').seq, undefined, '界面自己写的那几行没有序号可对');

// 展示档那一格筛的是行的种类：虚拟视口要量每一行的高度，藏着不画的那几类不进列表（D90、U48）。
const answered = projectRecord({ kind: 'assistant', text: '一句' })[0];
const reasoned = projectRecord({ kind: 'reasoning', text: '一段' })[0];
const resulted = projectRecord({ kind: 'tool', tool: 'read', callId: 'c7', args: {}, result: { content: { text: 'x' } } })[0];
assert.ok(shownIn('detailed', reasoned) && shownIn('detailed', resulted), '全量档什么都画');
assert.ok(shownIn('standard', resulted) && !shownIn('standard', reasoned), '标准档藏推理段');
assert.ok(shownIn('brief', answered) && !shownIn('brief', reasoned) && !shownIn('brief', resulted), '简略档只留问答');

// 一轮开始时的完整参数快照画成一行小字：档位来自哪一处都写在行里；内核没落这一条时（记录里没这一种事件）就不产行。
const ctx = projectRecord({ seq: 3, kind: 'turnContext', model: 'gpt-x', mode: 'full', policy: 'auto', policySource: 'session' })[0];
assert.equal(ctx.kind, 'context');
assert.equal(ctx.text, '这一轮用的是 模型 gpt-x · 模式 full · 审批档位 auto（这一份会话改的）');
assert.equal(projectRecord({ seq: 4, kind: 'turnContext', policy: 'ask', policySource: 'config' })[0].text, '这一轮用的是 审批档位 ask（配置默认）', '只带档位与来源时其余段不硬编');
assert.equal(projectRecord({ seq: 5, kind: 'turnContext' })[0], undefined, '几个读数都没有时这一行整个不画');
// 会话浮层里那几格读自 status.get：档位与它的来源是两格，界面上才说得出「现在生效的是配置默认还是会话临时改的」。
// 一张提问卡收掉时留下的那一句：题面与已经打下的字都要读得到，没打的那一道说清没打（审阅 F2、方案 R1）。
const echoAsk = { questions: [{ id: 'q1', question: '用哪一种格式' }, { id: 'q2', question: '要不要带表头' }] };
assert.equal(
  questionEcho(echoAsk, { q1: { picked: ['CSV'], extra: ' 压缩一份 ' }, q2: { picked: [], extra: '' } }),
  '第 1 题「用哪一种格式」：CSV、压缩一份；第 2 题「要不要带表头」：没有打下答案',
);
assert.equal(questionEcho({ questions: [{ id: 'q1', question: '一个问题' }] }), '第 1 题「一个问题」：没有打下答案', '一格草稿都没有时不谎称答过');
console.log('桌面前端的投影检查通过');
