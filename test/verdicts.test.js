// 判定结果那一格（D77、实现顺序第 38 步）：进记录、不进模型可见投影，也不改检查点算出来的那一段哈希；
// 汇总读的是这份记录，内核里没有第二份计数器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createCheckpoint,
  createSessionLog,
  formatVerdicts,
  prefixDigest,
  summarizeVerdicts,
  usableCheckpoint,
} from '../dist/index.js';

const tool = (seq, name, verdict, result = { kind: 'result', failed: false, content: 'ok' }) => ({ seq, kind: 'tool', tool: name, callId: `c${seq}`, args: {}, verdict, result });

const events = [
  tool(0, 'read', { capability: 'read', decision: 'allow', via: 'auto', level: 'auto' }),
  tool(1, 'read', { capability: 'read', decision: 'allow', via: 'auto', level: 'auto' }),
  tool(2, 'exec', { capability: 'exec', decision: 'allow', via: 'ask', level: 'auto', answer: 'allow' }, { kind: 'result', failed: false, content: 'done' }),
  tool(3, 'exec', { capability: 'exec', decision: 'deny', via: 'rule', level: 'auto', rule: 'rm *' }, { kind: 'refusal', failed: true, code: 'policy_denied', reason: 'no', content: '' }),
  tool(4, 'exec', { capability: 'exec', decision: 'deny', via: 'ask', level: 'auto', forced: true, answer: 'deny' }, { kind: 'refusal', failed: true, code: 'ask_declined', reason: 'no', content: '' }),
  tool(5, 'call', { capability: 'mcp:fs/read_file', decision: 'allow', via: 'rules', level: 'ask', rule: 'mcp:fs/*' }),
  { seq: 6, kind: 'tool', tool: 'write', callId: 'c6', args: {}, result: { kind: 'result', failed: false, content: 'ok' } },
];

test('the summary counts three buckets per capability name, not per registered tool', () => {
  const counts = summarizeVerdicts(events);
  assert.deepEqual(counts.map((item) => item.capability), ['exec', 'mcp:fs/read_file', 'read']);
  const exec = counts.find((item) => item.capability === 'exec');
  assert.deepEqual(
    { auto: exec.auto, asked: exec.asked, allowed: exec.allowed, denied: exec.denied },
    { auto: 0, asked: 1, allowed: 1, denied: 2 },
  );
  assert.deepEqual(exec.codes, { policy_denied: 1, ask_declined: 1 });
  assert.deepEqual(exec.rules, { 'rm *': 1 });
  // 被拒绝阈值压到逐次询问的那一次写成一个单独的档位读法（D77 那一格说的「来源那条规则或档位」）。
  assert.deepEqual(exec.levels, { auto: 2, 'auto→ask': 1 });
  // 没有判定链的那一次调用不在这份汇总里：那一格没有，就不猜。
  assert.equal(counts.some((item) => item.capability === 'write'), false);
});

test('the printed lines are the same numbers as the structured ones', () => {
  const lines = formatVerdicts(summarizeVerdicts(events));
  assert.match(lines[0], /^exec  自动 0  问过 1  没让做 2  档位 auto×2 auto→ask×1  命中规则 "rm \*"×1  码 policy_denied×1 ask_declined×1$/);
  assert.match(lines[2], /^read  自动 2  问过 0  没让做 0  档位 auto×2$/);
  assert.deepEqual(JSON.parse(JSON.stringify(summarizeVerdicts(events)))[1].capability, 'mcp:fs/read_file');
});

// 这一格是给人与排错读的：模型那一侧的形状、以及检查点算出来的那一段哈希都不该因为它变（D12、D75）。
test('the verdict stays out of the model view and out of the checkpoint hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-verdicts-'));
  const id = 'verdicts-session';
  const withVerdicts = createSessionLog({ directory, id });
  const plain = createSessionLog({ directory, id: `${id}-plain` });
  try {
    for (const event of events.filter((event) => event.seq < 4)) {
      await withVerdicts.append(event);
      const { verdict, ...rest } = event;
      await plain.append(rest);
    }
    assert.deepEqual(await withVerdicts.modelView(), await plain.modelView(), 'the projection does not read the verdict field');

    const recorded = await withVerdicts.read();
    const checkpoint = createCheckpoint({ id, events: recorded.slice(0, 3), text: '一段摘要', fromSeq: 0, toSeq: 2 });
    assert.deepEqual(usableCheckpoint(checkpoint, id, await plain.read()), { checkpoint, reason: '' });
    assert.equal(prefixDigest(recorded.slice(0, 3)), prefixDigest((await plain.read()).slice(0, 3)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
