// 第 32 步的验收（D73）：一份记录的第一行说清它是哪一版格式、属于哪一个项目、开局用哪一份模式清单，
// 而读的时候版本或事件种类读不懂就拒绝重建，不是静默跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSessionLog } from '../dist/index.js';

async function withDirectory(run) {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'format-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const tool = (seq, content) => JSON.stringify({ seq, kind: 'tool', tool: 'read', args: {}, result: { content } });

test('a new record starts with a line that names the format, the project and the mode it opened under', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({
      directory,
      id: 'run-1',
      meta: () => ({ projectRoot: '/repo', mode: { name: 'full', layer: 'user' } }),
    });
    const first = await session.append({ kind: 'user', text: 'go' });
    assert.equal(first.seq, 0, '首行不占事件的序号');

    const lines = (await readFile(session.path, 'utf8')).split('\n').filter((line) => line !== '').map(JSON.parse);
    assert.deepEqual(lines[0], {
      kind: 'session',
      formatVersion: 1,
      sessionId: 'run-1',
      projectRoot: '/repo',
      createdAt: lines[0].createdAt,
      mode: { name: 'full', layer: 'user' },
    });
    assert.deepEqual(await session.read(), [first], '首行不是一条事件，读回来的仍然只有那一条');
    assert.deepEqual(await session.header(), lines[0]);
  });
});

// 开局还没选过模式时那一格就是不写，而不是写一个空名字或写一份假的默认。
test('a record that never picked a mode says so by leaving the field out', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'run-2', meta: { projectRoot: '/repo' } });
    await session.append({ kind: 'user', text: 'go' });
    assert.equal('mode' in await session.header(), false);
  });
});

// 现存记录没有首行：按版本 0 读，读出来还是原来那几条，序号接着最后一条往后走。
test('a record written before the first line existed still reads and continues', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'legacy.jsonl');
    await writeFile(path, `${[tool(0, 'one'), tool(1, 'two')].join('\n')}\n`);
    const session = createSessionLog({ directory, id: 'legacy' });
    assert.equal(await session.header(), undefined);
    assert.deepEqual((await session.read()).map((event) => event.seq), [0, 1]);

    const next = await session.append({ kind: 'user', text: 'three' });
    assert.equal(next.seq, 2, '接在已有记录之后，不重复用号');
    // 一份开始就没有首行的记录不会被就地补一个头：那等于把同一份历史改成两种形状（D73）。
    assert.equal(await session.header(), undefined);
    assert.equal((await readFile(path, 'utf8')).split('\n').filter(Boolean).length, 3);
  });
});

test('a record from a newer format is refused instead of half read', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'future.jsonl');
    await writeFile(path, `${JSON.stringify({ kind: 'session', formatVersion: 2, sessionId: 'future', projectRoot: '/repo', createdAt: 'x' })}\n${tool(0, 'one')}\n`);
    await assert.rejects(() => createSessionLog({ directory, id: 'future' }).read(), (error) => {
      assert.equal(error.code, 'session_version_unsupported');
      assert.match(error.detail, /record is version 2/);
      return true;
    });
  });
});

test('an event kind this build does not know is refused unless the record says it may be skipped', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'kind.jsonl');
    await writeFile(path, `${tool(0, 'one')}\n${JSON.stringify({ seq: 1, kind: 'plan/step', text: 'x' })}\n`);
    await assert.rejects(() => createSessionLog({ directory, id: 'kind' }).read(), (error) => {
      assert.equal(error.code, 'session_event_unsupported');
      assert.equal(error.detail, 'plan/step');
      return true;
    });

    await writeFile(path, `${tool(0, 'one')}\n${JSON.stringify({ seq: 1, kind: 'plan/step', ignorable: true })}\n${tool(2, 'two')}\n`);
    const reopened = createSessionLog({ directory, id: 'kind' });
    assert.deepEqual((await reopened.read()).map((event) => event.tool), ['read', 'read'], '标过的种类可以被略过，剩下的一条不少');
    assert.equal((await reopened.modelView()).length, 2);
    const after = await reopened.append({ kind: 'user', text: 'next' });
    assert.equal(after.seq, 3, '略过一条不认识的事件不影响继续编号');
  });
});

// 首行之外再出现一份会话元信息，说明这份记录被拼接过；读下去只会读出错误的装配。
test('a second header line is a refusal, not a second session', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'spliced.jsonl');
    const header = JSON.stringify({ kind: 'session', formatVersion: 1, sessionId: 'spliced', projectRoot: '/repo', createdAt: 'x' });
    await writeFile(path, `${header}\n${tool(0, 'one')}\n${header}\n`);
    await assert.rejects(() => createSessionLog({ directory, id: 'spliced' }).read(), (error) => {
      assert.equal(error.code, 'session_header_position');
      return true;
    });
  });
});
