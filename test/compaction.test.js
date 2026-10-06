// 压缩的两条触发、切点与那一次修正（D75、D76，实现顺序第 37 步）。
// 端点是本地假的那一个：要验的是「什么时候压、压完投影是什么、压几次」，不是某一家端点的报错文案。
import test from 'node:test';
import { estimateRequest } from '../dist/session/compaction.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_LIMITS,
  KernelError,
  compactionLimitsOf,
  createCompaction,
  createConfig,
  createLoop,
  createSessionLog,
  cutPoint,
  estimateTokens,
  loadCheckpoint,
} from '../dist/index.js';

const SUMMARY = 'SUMMARY OF THE EARLIER TURNS';
const LONG = 'x'.repeat(2000);
const limits = { contextTokens: 4_000, compactThresholdRatio: 0.8, compactRetainRatio: 0.16, resultBytes: 16_000 };
const kernel = { manifest: () => [], execution: () => 'serial', call: async () => ({ ok: true }) };
const prompt = { render: () => 'the system prefix' };

// 假提供方：按脚本回答。看见那句摘要指令就答摘要，否则按 script 依次交事件或抛错。
function fakeProvider(script, summaryText = SUMMARY) {
  const seen = [];
  let index = 0;
  let summaries = 0;
  return {
    seen,
    summaries: () => summaries,
    model: 'fake',
    capabilities: {},
    async *stream(request) {
      seen.push(request);
      if (String(request.messages?.[0]?.text ?? '').startsWith('Write a summary')) {
        summaries += 1;
        yield { type: 'text', text: summaryText };
        return;
      }
      const next = script[Math.min(index, script.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      for (const event of next) yield event;
    },
  };
}

async function withSession(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-compaction-'));
  const id = 'compacting-session';
  const session = createSessionLog({ directory, id });
  try {
    return await run({ directory, id, session });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// 攒出足够长的一段历史，让投影的本地估算越得过那条线。
async function fill(session, rounds) {
  for (let round = 0; round < rounds; round += 1) {
    await session.append({ kind: 'user', text: `问题 ${round} ${LONG}` });
    await session.append({ kind: 'assistant', text: `答 ${round} ${LONG}`, toolCalls: [] });
  }
}

test('the cut point lands on a user or assistant event and keeps the tail under the budget', () => {
  const events = [
    { seq: 0, kind: 'user', text: LONG },
    { seq: 1, kind: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'read', args: {} }] },
    { seq: 2, kind: 'tool', tool: 'read', callId: 'c1', result: { failed: false, content: LONG } },
    { seq: 3, kind: 'user', text: LONG },
    { seq: 4, kind: 'assistant', text: LONG },
  ];
  // 预算只放得下最后一条时，切点往后落到 4 号那条 assistant：切在 2 号那条工具结果上会留下没人回答的调用。
  assert.equal(cutPoint(events, estimateTokens(events[4])), 4);
  assert.equal(cutPoint(events, 1), 4);
  // 预算装得下整段时不切。
  assert.equal(cutPoint(events, 10_000), null);
});

test('pressure over the line compacts once and the next request carries the summary', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 4);
    const logBefore = await readFile(join(directory, `${id}.jsonl`), 'utf8');
    const lines = logBefore.trim().split('\n').length;
    const logged = [];
    const logger = { log: (message, fields) => logged.push({ message, ...fields }) };
    const provider = fakeProvider([[{ type: 'text', text: 'continued' }]]);
    const compaction = createCompaction({ provider, session, directory, id, limits, logger });

    const result = await createLoop({ kernel, provider, prompt, session, compaction }).run('再问一句', {});
    assert.equal(result.text, 'continued');

    const read = await loadCheckpoint({ directory, id, events: await session.read() });
    assert.equal(read.reason, '', 'the checkpoint the compaction wrote matches the log');
    assert.equal(read.checkpoint.text, SUMMARY);
    const last = (await session.read()).at(-1);
    assert.ok(read.checkpoint.fromSeq >= 0 && read.checkpoint.toSeq < last.seq);

    const sent = provider.seen.at(-1);
    assert.equal(sent.messages[0].text, SUMMARY, 'the covered range is replaced by the summary');
    assert.equal(sent.messages.at(-1).text, '再问一句', 'the input of this round is still there');

    const after = await readFile(join(directory, `${id}.jsonl`), 'utf8');
    assert.equal(after.trim().split('\n').length, lines + 2, 'the round adds its own two events and the checkpoint adds none');
    const numbers = logged.find((entry) => entry.message === 'session compacted');
    assert.ok(numbers.tokensBefore > numbers.tokensAfter, 'a summary removes more than it adds');
  });
});

const overflow = new KernelError('provider_http_error', { detail: '400 the input is longer than the maximum context length' });

// 超长那一条只在端点报回之后走，而整个运行只允许一次压缩加一次重试（D75）。
test('an endpoint overflow answer gets one compaction and one retry', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 2);
    const provider = fakeProvider([overflow, [{ type: 'text', text: 'after the retry' }]]);
    const compaction = createCompaction({ provider, session, directory, id, limits });
    const result = await createLoop({ kernel, provider, prompt, session, compaction }).run('继续', {});
    assert.equal(result.text, 'after the retry');
    assert.equal(provider.summaries(), 1, 'exactly one summary call');
    assert.equal((await loadCheckpoint({ directory, id, events: await session.read() })).reason, '');
    // 那一次报超长之前没压过：压力那一条量的是本地估算，这一段还没越线。
    assert.equal(provider.seen.filter((request) => String(request.messages?.[0]?.text ?? '') === SUMMARY).length, 1);
  });
});

test('a second overflow answer does not buy a second compaction', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 2);
    const provider = fakeProvider([overflow, overflow]);
    const compaction = createCompaction({ provider, session, directory, id, limits });
    await assert.rejects(
      createLoop({ kernel, provider, prompt, session, compaction }).run('继续', {}),
      (error) => error.code === 'provider_http_error',
    );
    assert.equal(provider.summaries(), 1, 'the one allowed compaction is spent');
  });
});

// 不是超长的失败不压：那一格错误说的不是窗口不够。
test('a provider failure that is not about length leaves the record alone', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 2);
    const provider = fakeProvider([new KernelError('provider_http_error', { detail: '400 invalid api key' })]);
    const compaction = createCompaction({ provider, session, directory, id, limits });
    await assert.rejects(
      createLoop({ kernel, provider, prompt, session, compaction }).run('继续', {}),
      (error) => error.code === 'provider_http_error' && error.detail.includes('invalid api key'),
    );
    assert.equal(provider.summaries(), 0, 'no summary was asked for');
    assert.equal((await loadCheckpoint({ directory, id, events: await session.read() })).reason, 'checkpoint_absent');
  });
});

// 本地估算修正过才谈得上压力：端点报回的真实用量比本地大时，那条线要跟着提前响（D75）。
test('the local estimate is corrected by the usage the endpoint reports back', async () => {
  await withSession(async ({ directory, id, session }) => {
    await session.append({ kind: 'user', text: '短' });
    await session.append({ kind: 'assistant', text: '也短' });
    const provider = fakeProvider([
      [{ type: 'tool-call', id: 'c1', name: 'noop', args: {} }, { type: 'usage', input: 12_000, output: 20 }],
      [{ type: 'text', text: '第二轮' }],
    ]);
    const compaction = createCompaction({ provider, session, directory, id, limits });
    const result = await createLoop({ kernel, provider, prompt, session, compaction }).run('第三句', {});
    assert.equal(result.text, '第二轮');
    // 按本地的字节数这一份远不到线，是修正系数让压力那一条在第二次请求之前响起来。
    assert.ok(estimateTokens(await session.read()) < limits.contextTokens * limits.compactThresholdRatio);
    assert.equal(provider.summaries(), 1, 'the corrected estimate triggers the pressure line');
    assert.equal((await session.modelView())[0].text, SUMMARY);
  });
});

// 检查点里只有摘要与范围，没有任何「模型以前知道过」的那几格；被顶掉的那些事件仍然在日志里（D76、I5）。
test('the checkpoint carries no disclosure state and the log keeps every event', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 4);
    await session.append({ kind: 'mode', name: 'full', layer: 'shipped', tools: ['read'], digest: 'aaaaaaaaaaaa', path: '/x/full.toml' });
    const provider = fakeProvider([[{ type: 'text', text: 'ok' }]]);
    const compaction = createCompaction({ provider, session, directory, id, limits });
    await createLoop({ kernel, provider, prompt, session, compaction }).run('一句', {});

    const raw = JSON.parse(await readFile(join(directory, `${id}.checkpoint.json`), 'utf8'));
    assert.deepEqual(Object.keys(raw).sort(), ['digest', 'formatVersion', 'fromSeq', 'inputVersion', 'sessionId', 'text', 'toSeq']);
    const events = await session.read();
    assert.equal(events.filter((event) => event.kind === 'mode').length, 1, 'a mode event is not anything the summary swallows');
    assert.ok(events.length > (await loadCheckpoint({ directory, id, events })).checkpoint.toSeq, 'no event left the log');
  });
});

// 第二次压缩从上一次保留的边界开始，并把上一次的摘要当作输入（D75）。
test('the next compaction starts at the kept boundary and feeds the previous summary in', async () => {
  await withSession(async ({ directory, id, session }) => {
    const provider = fakeProvider([[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }], [{ type: 'text', text: 'three' }]]);
    const compaction = createCompaction({ provider, session, directory, id, limits });
    const loop = createLoop({ kernel, provider, prompt, session, compaction });
    assert.equal((await loadCheckpoint({ directory, id, events: await session.read() })).reason, 'checkpoint_absent');

    await fill(session, 4);
    await loop.run('A', {});
    const first = await loadCheckpoint({ directory, id, events: await session.read() });
    assert.equal(first.reason, '');

    await fill(session, 4);
    await loop.run('B', {});
    const second = await loadCheckpoint({ directory, id, events: await session.read() });
    assert.equal(second.reason, '');
    assert.equal(second.checkpoint.fromSeq, first.checkpoint.fromSeq, 'the merged range still starts at the old boundary');
    assert.ok(second.checkpoint.toSeq > first.checkpoint.toSeq, 'the second compaction covers further into the log');
    const excerpt = provider.seen.filter((request) => String(request.messages?.[0]?.text ?? '').startsWith('Write a summary')).at(-1);
    assert.match(String(excerpt.messages[0].text), /Earlier summary:\nSUMMARY/, 'the previous summary is part of the input');
  });
});

// 摘要文本也受注入那一层的上限约束（I6）：超了整份溢出到文件，检查点里留可取回的引用。
test('an oversized summary spills to a file with a retrievable reference', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 4);
    const provider = fakeProvider([[{ type: 'text', text: 'ok' }]], 'y'.repeat(40_000));
    const compaction = createCompaction({ provider, session, directory, id, limits: { ...limits, resultBytes: 2_000 } });
    await createLoop({ kernel, provider, prompt, session, compaction }).run('一句', {});
    const text = (await loadCheckpoint({ directory, id, events: await session.read() })).checkpoint.text;
    const reference = /full output is 40000 bytes, kept in (\S+)\]/.exec(text);
    assert.ok(reference, `the checkpoint keeps a reference: ${text.slice(-80)}`);
    assert.ok((await readFile(join(directory, reference[1]), 'utf8')).startsWith('yyyy'));
  });
});

// 窗口那一格没写就不启用压缩（D75 修订，2026-10-05 定）：0.8 与 0.16 是策略参数可以给缺省，
// 窗口大小是模型事实——猜大了会让摘要请求自己超窗，所以没配置的人正常聊天照跑而不自动压。
test('compaction stays off until the model window is configured', () => {
  assert.equal(compactionLimitsOf(createConfig({ user: { limits: {} } })), undefined);
  assert.equal(DEFAULT_LIMITS.contextTokens, undefined, 'the window has no shipped default to fall back on');
  assert.equal(compactionLimitsOf(createConfig({ user: { limits: { contextTokens: 128_000 } } })).compactRetainRatio, 0.16);
  for (const written of [
    { contextTokens: 0 },
    { contextTokens: '128000' },
    { contextTokens: 128_000, compactThresholdRatio: 0 },
    { contextTokens: 128_000, compactRetainRatio: 0.9 },
    { contextTokens: 128_000, compactThresholdRatio: 2 },
  ]) {
    assert.throws(
      () => compactionLimitsOf(createConfig({ user: { limits: written } })),
      (error) => error.code === 'host_compaction_limits_invalid',
      `${JSON.stringify(written)} is refused rather than silently disabling the line`,
    );
  }
});

// 端点报回的用量落成一条记录事件（D82）：界面与恢复读的是记录，不是上一次进程留在内存里的那个数。
test('the usage an endpoint reports lands in the record and never in the projection', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 2);
    const compaction = createCompaction({ provider: fakeProvider([]), session, directory, id, limits });
    const messages = await session.modelView();
    await compaction.observe({ messages }, [{ type: 'usage', input: 1200, output: 80 }]);
    const usage = (await session.read()).at(-1);
    assert.equal(usage.kind, 'usage');
    assert.equal(usage.ignorable, true, '读不懂它的旧程序略过这一条，而不是拒绝打开这份记录');
    assert.deepEqual([usage.input, usage.output], [1200, 80]);
    assert.equal(usage.estimated, estimateRequest({ messages }), '估算保留完整请求的结构');
    assert.equal(usage.measurement, 'request-v1');
    // 投影里没有它的位置：它不是模型说过的话，也不是工具结果。
    assert.deepEqual((await session.modelView()).map((entry) => entry.role), ['user', 'assistant', 'user', 'assistant']);
    // 一条都没报回时不再多写一条：0 不是「用量是零」，是「没说」。
    const before = (await session.read()).length;
    await compaction.observe({ messages }, [{ type: 'text', text: 'no usage here' }]);
    assert.equal((await session.read()).length, before);
  });
});

// 重开一份会话不该从「从没校准过」重新开始：系数从记录里最后一条用量算回来（D82）。
test('a fresh compaction over a record that carries usage starts calibrated', async () => {
  await withSession(async ({ directory, id, session }) => {
    await fill(session, 2);
    const local = estimateRequest({ messages: await session.modelView() });
    await session.append({ kind: 'usage', ignorable: true, input: local * 3, output: 10, estimated: local, measurement: 'request-v1' });
    const compaction = createCompaction({ provider: fakeProvider([]), session, directory, id, limits });
    const context = await compaction.context();
    assert.equal(context.factor, 3);
    assert.equal(context.estimated, local * 3);
    assert.deepEqual([context.window, context.threshold, context.retained], [4000, 3200, 640]);
    assert.deepEqual([context.reported.input, context.reported.output], [local * 3, 10]);
  });
});

// 手动那一条与自动那两条走同一次摘要生成；切不动时说清切不动（D83）。
test('a manual compaction writes the same checkpoint and says when there is nothing to cut', async () => {
  await withSession(async ({ directory, id, session }) => {
    const compaction = createCompaction({ provider: fakeProvider([], 'MANUAL SUMMARY'), session, directory, id, limits });
    assert.equal(await compaction.compactNow(), null, '一段可切的边界都还没有时不写检查点');
    await fill(session, 3);
    const done = await compaction.compactNow();
    assert.ok(done !== null && done.toSeq >= done.fromSeq && done.tokensAfter < done.tokensBefore);
    const read = await loadCheckpoint({ directory, id, events: await session.read() });
    assert.equal(read.reason, '', '手动写出去的那一份与日志对得上');
    assert.equal(read.checkpoint.text, 'MANUAL SUMMARY');
    assert.equal((await session.modelView())[0].text, 'MANUAL SUMMARY', '压完的投影第一段就是那份摘要');
  });
});

// 摘要比它顶掉的那一段还长时不压（第 43 步补的那一条护栏）：那种检查点只会让模型少读历史、多读一份摘要，
// 而它顶掉的那一段再也不会被读到——压不动就说清压不动。
test('a summary that would not shrink the projection is refused', async () => {
  await withSession(async ({ directory, id, session }) => {
    for (let round = 0; round < 4; round += 1) {
      await session.append({ kind: 'user', text: `第 ${round} 问` });
      await session.append({ kind: 'assistant', text: `第 ${round} 答`, toolCalls: [] });
    }
    const logged = [];
    const compaction = createCompaction({
      provider: fakeProvider([], 'A '.repeat(400)),
      session,
      directory,
      id,
      limits: { contextTokens: 1000, compactThresholdRatio: 0.8, compactRetainRatio: 0.05, resultBytes: 16_000 },
      logger: { log: (message, fields) => logged.push({ message, ...fields }) },
    });
    assert.equal(await compaction.compactNow(), null);
    assert.ok(logged.some((entry) => String(entry.message).includes('would not shrink')), '要说清为什么没压');
    await assert.rejects(() => readFile(join(directory, `${id}.checkpoint.json`), 'utf8'), '没写出检查点');
  });
});
