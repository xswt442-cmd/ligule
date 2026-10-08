// 每轮那一份生效参数冻进记录（D104、实现顺序第 125 步）：一次受理留一条，投影与请求体读不到它。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection, createConfig, createMemoryConnectionPair, MESSAGES_CAPABILITIES, serveHost } from '../dist/index.js';

test('one round freezes the parameters in effect at its start into one record event', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-turn-context-'));
  const config = createConfig({
    user: {
      boundary: directory,
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
      policy: { mode: 'auto' },
    },
  });
  const requests = [];
  let turns = 0;
  const provider = {
    capabilities: MESSAGES_CAPABILITIES,
    model: 'test-model',
    async *stream(request) {
      requests.push(request);
      // 第一次让模型提一次工具调用，第二次才收尾：本轮内部两个 loop 也只该留下一条快照。
      turns += 1;
      if (turns === 1) {
        yield { type: 'tool-call', id: 'call_1', name: 'exec', args: { command: 'git status' } };
        return;
      }
      yield { type: 'text', text: '本轮结束' };
    },
  };
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy });
  const connection = createConnection(pair.client);
  try {
    const { sessionId } = await connection.request('session.create', {});
    await connection.request('run.start', { sessionId, input: '第一轮' });
    await connection.request('run.start', { sessionId, input: '第二轮' });
    const { events } = await connection.request('session.read', { sessionId });
    const snapshots = events.filter((event) => event.kind === 'turnContext');
    const inputs = events.filter((event) => event.kind === 'user');
    assert.equal(snapshots.length, 2, '两个真实用户轮次各留一条，内部多一次 loop 也不多留');
    assert.deepEqual(snapshots.map((event) => event.userSeq), inputs.map((event) => event.seq), '每一条指着自己那一轮那条输入');
    assert.equal(snapshots[0].model, 'test-model');
    assert.equal(snapshots[0].api, 'messages');
    assert.equal(snapshots[0].policy, 'auto');
    assert.equal(snapshots[0].policySource, 'config', '没人改过档位时说的是配置那一份');
    assert.equal(snapshots[0].text, undefined, '快照不装正文');

    // 交回界面之前先确认它没进模型那一份上下文（D75 的白名单同一件事）。
    const last = requests.at(-1);
    assert.ok(!JSON.stringify(last.messages).includes('turnContext'), '请求体里读不到这一条');
    // 配置四层都没写静态段时，交出去的系统提示是随包那一份基础提示（D102）。
    assert.match(JSON.stringify(last), /ligule/, '随包的基础提示进了请求');
    const reopened = await connection.request('status.get', { sessionId });
    assert.ok(reopened.eventCount >= events.length, '状态上的条数与记录同源');
  } finally {
    pair.client.output.end();
    await host.release();
    await rm(directory, { recursive: true, force: true });
  }
});

// 会话覆盖过档位之后，那一轮留下的快照说的是覆盖那一份（D101 与 D104 合起来才读得出「当时按哪一档跑的」）。
test('the snapshot names the tier the round actually ran on after a session override', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-turn-tier-'));
  const config = createConfig({
    user: {
      boundary: directory,
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
      policy: { mode: 'ask' },
      // 写了静态段的那一层整份换掉随包那一份，不是在它后面追加（D102、D8 的标量合并语义）。
      prompt: { static: '只看这一句' },
    },
  });
  const seen = [];
  const provider = {
    capabilities: MESSAGES_CAPABILITIES,
    model: 'test-model',
    async *stream(request) {
      seen.push(request);
      yield { type: 'text', text: '一句话' };
    },
  };
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy });
  const connection = createConnection(pair.client);
  try {
    const { sessionId } = await connection.request('session.create', {});
    await connection.request('policy.set', { sessionId, mode: 'auto' });
    await connection.request('run.start', { sessionId, input: '甲' });
    const { events } = await connection.request('session.read', { sessionId });
    const snapshot = events.find((event) => event.kind === 'turnContext');
    assert.equal(snapshot.policy, 'auto');
    assert.equal(snapshot.policySource, 'session');
    const body = JSON.stringify(seen.at(-1));
    assert.ok(body.includes('只看这一句') && !body.includes('编程助手'), '写了静态段的那一层整份换掉了随包那一份（D102）');
  } finally {
    pair.client.output.end();
    await host.release();
    await rm(directory, { recursive: true, force: true });
  }
});
