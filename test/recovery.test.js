// 第 33 步的验收（D72、D79）：崩溃留下的那次派发补成一条规范的工具结果，只读的那一侧不改盘，补一次就够。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  buildRepairEvents, createConnection, createConfig, createMemoryConnectionPair, createSessionLog,
  findUnresolvedCalls, repairUnresolvedCalls, serveHost,
} from '../dist/index.js';

const READ_ONLY = new Set(['read']);
const dispatched = (seq, id, name, args) => ({ seq, kind: 'assistant', text: '', toolCalls: [{ id, name, args }] });

test('an assistant turn whose call never got a result is the only thing left open', () => {
  const events = [
    { seq: 0, kind: 'user', text: 'go' },
    dispatched(1, 'a', 'exec', { command: 'make' }),
    { seq: 2, kind: 'tool', tool: 'exec', callId: 'a', result: { content: 'ok' } },
    dispatched(3, 'b', 'read', { path: 'x' }),
    { seq: 4, kind: 'tool', tool: 'mcp.call', callId: 'c', result: { content: 'other call' } },
  ];
  assert.deepEqual(findUnresolvedCalls(events), [{ tool: 'read', callId: 'b', args: { path: 'x' }, assistantSeq: 3 }],
    '有结果的那一次不算开放，别的调用 id 的结果也不算对上');
  const [repaired] = buildRepairEvents(findUnresolvedCalls(events), { readOnly: READ_ONLY });
  assert.equal(repaired.kind, 'tool');
  assert.equal(repaired.callId, 'b');
  assert.equal(repaired.result.failed, true);
  assert.equal(repaired.result.code, 'tool_outcome_unknown');
  assert.deepEqual(repaired.recovery, { assistantSeq: 3, safeToRedo: true });
  // 措辞按这一件工具改不改本机之外的东西分开：只读的说「需要就重跑」，可能改了外部状态的说「先看现状，别盲目重试」。
  assert.match(repaired.result.content, /does not change anything on this machine/);
  const [mayHaveLanded] = buildRepairEvents([{ tool: 'exec', callId: 'b', args: {}, assistantSeq: 3 }], { readOnly: READ_ONLY });
  assert.match(mayHaveLanded.result.content, /may or may not have happened/);
  assert.match(mayHaveLanded.result.content, /read the current state first/);
});

test('reopening a record repairs it once, and reading it changes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-recovery-'));
  // 记录落数据根会话区（D110）：检查自己造的家目录里那一处，宿主读的也是它。
  const directory = join(homedir(), '.ligule', 'sessions');
  try {
    const log = createSessionLog({ directory, id: 'crashed', meta: { projectRoot: root } });
    await log.append({ kind: 'user', text: 'build it' });
    await log.append(dispatched(1, 'call_x', 'exec', { command: 'make' }));

    // 只读的那一侧（协议里的 session.read 走的就是这一条）报告缺口而不写盘（D72）。
    const before = await readFile(join(directory, 'crashed.jsonl'), 'utf8');
    assert.equal((await createSessionLog({ directory, id: 'crashed' }).read()).length, 2);
    assert.equal(await readFile(join(directory, 'crashed.jsonl'), 'utf8'), before, '读一遍没有改动这份记录');

    const config = createConfig({
      user: { boundary: root, model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'm' }, policy: { mode: 'ask' } },
    });
    const pair = createMemoryConnectionPair();
    const host = serveHost({ ...pair.host, config, provider: { name: 'none', model: 'm', async *stream() { throw new Error('no round runs here'); } }, policy: config.policy });
    const client = createConnection(pair.client);
    const { events } = await client.request('session.open', { sessionId: 'crashed' }).then(() => client.request('session.read', { sessionId: 'crashed' }));
    await host.close?.();

    const repaired = events.find((event) => event.result?.code === 'tool_outcome_unknown');
    assert.ok(repaired, '可写的恢复路径把那次派发补成了一条结果');
    assert.equal(repaired.callId, 'call_x');
    assert.equal(repaired.recovery.safeToRedo, false, 'exec 没声明只读，所以那句话是「先看现状」');
    assert.deepEqual(events.map((event) => event.seq), [0, 1, 2], '补出来的那一条接在最后一条之后');
    assert.equal((await readFile(join(directory, 'crashed.jsonl'), 'utf8')).trim().split('\n').length, 4,
      '首行加三条事件');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a second repair pass adds nothing because the calls are answered now', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-repair-'));
  try {
    const session = createSessionLog({ directory: root, id: 'twice' });
    await session.append({ kind: 'user', text: 'go' });
    await session.append(dispatched(1, 'x', 'exec', { command: 'make' }));
    assert.equal((await repairUnresolvedCalls(session, { readOnly: new Set() })).length, 1);
    assert.equal((await repairUnresolvedCalls(createSessionLog({ directory: root, id: 'twice' }), { readOnly: new Set() })).length, 0,
      '再扫一次：那些调用已经有结果了，一条都不补');
    const lines = (await readFile(join(root, 'twice.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.kind), ['session', 'user', 'assistant', 'tool']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
