// 检查点那一份派生文件（D75、实现顺序第 36 步）：范围与哈希对上时投影读它，任何一处对不上就整份作废、回原始日志。
// 事件日志一条都不动，所以这里比的是「读出来的投影」而不是「写过什么」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CHECKPOINT_FORMAT_VERSION,
  CHECKPOINT_INPUT_VERSION,
  checkpointPath,
  createCheckpoint,
  createSessionLog,
  loadCheckpoint,
  prefixDigest,
  usableCheckpoint,
} from '../dist/index.js';

const EVENTS = [
  { kind: 'user', text: '第一个问题' },
  { kind: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'read', args: { path: 'note.txt' } }] },
  { kind: 'tool', tool: 'read', callId: 'call_1', args: { path: 'note.txt' }, result: { kind: 'result', failed: false, content: { text: 'the body' } } },
  { kind: 'user', text: '第二个问题' },
  { kind: 'assistant', text: '答完了' },
];

async function withRecord(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-checkpoint-'));
  const id = 'session-under-test';
  const session = createSessionLog({ directory, id });
  for (const event of EVENTS) await session.append(event);
  try {
    return await run({ directory, id, session, path: join(directory, `${id}.jsonl`) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const write = (directory, id, checkpoint) => writeFile(checkpointPath(directory, id), JSON.stringify(checkpoint));

test('a checkpoint whose range and hash match takes that range out of the model view', async () => {
  await withRecord(async ({ directory, id, session, path }) => {
    const events = await session.read();
    const before = await readFile(path, 'utf8');
    await write(directory, id, createCheckpoint({ id, events: events.slice(0, 3), text: '前几轮的话', fromSeq: 0, toSeq: 2 }));

    const view = await session.modelView();
    assert.deepEqual(view[0], { role: 'user', text: '前几轮的话' }, 'the summary speaks for the covered range');
    assert.deepEqual(view.slice(1).map((row) => row.role), ['user', 'assistant'], 'events after the range stay as they are');
    assert.equal(await readFile(path, 'utf8'), before, 'the event log is not touched by a checkpoint');
    assert.equal((await loadCheckpoint({ directory, id, events })).reason, '');
  });
});

// 每一种对不上的写法要说清是哪一个条件，并且投出来的是原始日志那一份（D75：派生文件可弃）。
test('a checkpoint that does not line up is void and the raw log projects as if it were never there', async () => {
  const cases = [
    ['checkpoint_absent', undefined],
    ['checkpoint_invalid_json', '{'],
    ['checkpoint_format_version', (base) => ({ ...base, formatVersion: CHECKPOINT_FORMAT_VERSION + 1 })],
    ['checkpoint_input_version', (base) => ({ ...base, inputVersion: CHECKPOINT_INPUT_VERSION + 1 })],
    ['checkpoint_session_mismatch', (base) => ({ ...base, sessionId: 'another-session' })],
    ['checkpoint_range_shape', (base) => ({ ...base, fromSeq: 3, toSeq: 1 })],
    ['checkpoint_range_missing', (base) => ({ ...base, toSeq: 40 })],
    ['checkpoint_text_missing', (base) => ({ ...base, text: '' })],
    ['checkpoint_digest_mismatch', (base) => ({ ...base, digest: '0'.repeat(64) })],
  ];
  await withRecord(async ({ directory, id, session, path }) => {
    const events = await session.read();
    const plain = await session.modelView();
    const base = createCheckpoint({ id, events: events.slice(0, 3), text: '前几轮的话', fromSeq: 0, toSeq: 2 });

    for (const [reason, mutate] of cases) {
      if (mutate === undefined) await rm(checkpointPath(directory, id), { force: true });
      else if (typeof mutate === 'string') await writeFile(checkpointPath(directory, id), mutate);
      else await write(directory, id, mutate(base));
      const read = await loadCheckpoint({ directory, id, events });
      assert.equal(read.reason, reason, `${reason} is the named condition`);
      assert.equal(read.checkpoint, null);
      assert.deepEqual(await session.modelView(), plain, `${reason} falls back to the raw log`);
    }

    // 换一段范围：那一段重算出来的哈希不是这一份。
    await write(directory, id, { ...base, fromSeq: 1, toSeq: 3 });
    assert.equal((await loadCheckpoint({ directory, id, events })).reason, 'checkpoint_digest_mismatch');
    assert.deepEqual(await session.modelView(), plain);

    // 改掉那一段里的一个字节：哈希对不上，而读出来的还是原始日志那一份（不改写日志，也不改写它）。
    const bytes = await readFile(path, 'utf8');
    await writeFile(path, bytes.replace('第一个问题', '第一个问题改过'));
    const edited = await session.read();
    assert.equal((await loadCheckpoint({ directory, id, events: edited })).reason, 'checkpoint_digest_mismatch');
    assert.ok(!(await session.modelView()).some((row) => row.text === '前几轮的话'), 'the void checkpoint is not projected');
    assert.equal((await loadCheckpoint({ directory, id, events: [] })).reason, 'checkpoint_range_missing');
  });
});

// 哈希的输入只由参与重建的那几格决定：一次性的传输身份（调用 id、溢出用的文件名）与后来才出现的外层字段都不进输入（D75）。
test('the hash input leaves out transport identity and fields this build does not know', async () => {
  const decorated = (token) => EVENTS.slice(0, 3).map((event, index) => ({
    ...event,
    hostNote: token,
    ...(index === 2 ? { result: { ...event.result, spilled: `result-${token}-abcdef01.json` } } : {}),
    ...(event.toolCalls === undefined ? {} : { toolCalls: event.toolCalls.map((call) => ({ ...call, id: `call-${token}` })) }),
  }));
  await withRecord(async ({ directory, id, session }) => {
    const events = await session.read();
    assert.equal(prefixDigest(decorated('one')), prefixDigest(decorated('two')), 'a different call id is the same history');
    const checkpoint = createCheckpoint({ id, events: events.slice(0, 3), text: '前几轮的话', fromSeq: 0, toSeq: 2 });

    // 给记录加一个这一具程序不认识的外层字段之后，旧检查点仍然有效：输入按固定的那几格拼。
    // 执行耗时那一格（第 66 步）也是外层字段，同样不动哈希。
    const widened = events.map((event) => ({ ...event, thinkingTokens: 12, durationMs: 40 }));
    assert.deepEqual(usableCheckpoint(checkpoint, id, widened), { checkpoint, reason: '' });
    assert.notEqual(prefixDigest(widened), prefixDigest(widened.map((event) => ({ ...event, text: `${event.text}.` }))), 'a real content change still moves the hash');
  });
});

// `usage` 那一格不进哈希输入，也不该占出一个「缺号」来（D82 与 D75 的交界处）：
// 它进了记录之后，一份本来对得上的检查点不该因此作废。
test('a usage event inside the covered range leaves the checkpoint alone', () => {
  const id = 'usage-in-range';
  const events = [
    { seq: 0, kind: 'user', text: 'one' },
    { seq: 1, kind: 'assistant', text: 'two', toolCalls: [] },
    { seq: 2, kind: 'usage', input: 400, output: 5, estimated: 120 },
    { seq: 3, kind: 'user', text: 'three' },
  ];
  const checkpoint = createCheckpoint({ id, events: events.slice(0, 3), text: '一份摘要', fromSeq: 0, toSeq: 2 });
  assert.equal(prefixDigest(events), prefixDigest(events.filter((event) => event.kind !== 'usage')), '用量那一格不参与输入');
  assert.deepEqual(usableCheckpoint(checkpoint, id, events), { checkpoint, reason: '' }, '序号还是连着的，检查点照用');
  // 反过来读：谁把它当成「可以略过的那一种」丢掉，那段范围就缺号——这正是它要在 WRITTEN_KINDS 里的理由。
  assert.equal(usableCheckpoint(checkpoint, id, events.filter((event) => event.kind !== 'usage')).reason, 'checkpoint_range_missing');
});
