// 检查点是可重建的派生文件：范围和哈希匹配时用于投影，任一校验失败就回读原始日志。
// 检查点不会修改事件日志，因此测试比较读取到的投影内容。
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

// 每种校验失败都应说明原因，并使用原始日志生成投影。
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

    // 更改检查点范围，使其摘要与记录不再匹配。
    await write(directory, id, { ...base, fromSeq: 1, toSeq: 3 });
    assert.equal((await loadCheckpoint({ directory, id, events })).reason, 'checkpoint_digest_mismatch');
    assert.deepEqual(await session.modelView(), plain);

    // 修改范围内的一个字符后，哈希校验应失败，并继续从原始日志生成投影。
    const bytes = await readFile(path, 'utf8');
    await writeFile(path, bytes.replace('第一个问题', '第一个问题改过'));
    const edited = await session.read();
    assert.equal((await loadCheckpoint({ directory, id, events: edited })).reason, 'checkpoint_digest_mismatch');
    assert.ok(!(await session.modelView()).some((row) => row.text === '前几轮的话'), 'the void checkpoint is not projected');
    assert.equal((await loadCheckpoint({ directory, id, events: [] })).reason, 'checkpoint_range_missing');
  });
});

// 哈希只覆盖重建投影所需的数据，不包含调用 ID、溢出文件名等传输字段。
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

    // 添加未知外层字段后，检查点仍然有效，因为哈希只覆盖固定字段。
    // 执行耗时是事件的外层字段，不参与哈希。
    const widened = events.map((event) => ({ ...event, thinkingTokens: 12, durationMs: 40 }));
    assert.deepEqual(usableCheckpoint(checkpoint, id, widened), { checkpoint, reason: '' });
    assert.notEqual(prefixDigest(widened), prefixDigest(widened.map((event) => ({ ...event, text: `${event.text}.` }))), 'a real content change still moves the hash');
  });
});

// `usage` 不参与哈希，也不会让投影事件的序号出现空缺：
// 写入用量事件后，原本有效的检查点仍应通过校验。
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
  // 若把用量事件从序号范围中跳过，事件范围就会不连续，因此它必须计入已写入事件类型。
  assert.equal(usableCheckpoint(checkpoint, id, events.filter((event) => event.kind !== 'usage')).reason, 'checkpoint_range_missing');
});
