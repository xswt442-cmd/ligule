// 第 34 步的验收（D73、D78）：列表从记录目录扫出来，恢复用记录里最后生效的那份模式清单并比摘要。
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTuiHost } from './helpers/tui-host.js';
import {
  chooseResumeMode, createConfig, createConnection, createMemoryConnectionPair, createSessionLog, listSessions,
  loadMode, MESSAGES_CAPABILITIES, modeDirectories, searchSessions, serveHost, sessionDirectory,
} from '../dist/index.js';

const shippedModes = fileURLToPath(new URL('../modes/', import.meta.url));

// 摘要由 `loadMode` 算出来，这里只取一份真实值用于比对。
async function digestOf(name) {
  return (await loadMode(name, { shipped: shippedModes, user: join('a', 'b'), project: join('c', 'd') })).digest;
}

async function withSessions(run) {
  const testplace = resolve('testplace');
  await mkdir(testplace, { recursive: true });
  const root = await mkdtemp(join(testplace, 'ligule-sessions-'));
  const absoluteRoot = resolve(root);
  assert.equal(absoluteRoot.startsWith(`${testplace}${process.platform === 'win32' ? '\\' : '/'}`), true);
  const directory = join(root, '.ligule', 'sessions');
  await mkdir(directory, { recursive: true });
  try {
    return await run(root, directory);
  } finally {
    await rm(absoluteRoot, { recursive: true, force: true });
  }
}

test('the session directory follows the boundary unless the config names one', async () => {
  assert.equal(sessionDirectory({ boundary: '/work' }), join('/work', '.ligule', 'sessions'));
  assert.equal(sessionDirectory({ boundary: '/work', host: { sessionDirectory: '/elsewhere' } }), '/elsewhere');
});

test('the listing reads each record once and reports what a resume would need', async () => {
  await withSessions(async (root, directory) => {
    const fresh = createSessionLog({ directory, id: 'fresh', meta: () => ({ projectRoot: root, mode: { name: 'full', layer: 'shipped' } }) });
    await fresh.append({ kind: 'mode', name: 'full', layer: 'shipped', path: 'modes/full.toml', tools: ['read'], digest: 'aaa111' });
    await fresh.append({ kind: 'user', text: 'go' });
    await fresh.append({ kind: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'exec', args: { command: 'make' } }] });
    await fresh.append({ kind: 'tool', tool: 'read', callId: 'other', args: {}, result: { content: 'x' } });

    // 加首行之前的现存记录：没有首行也列得出来，版本读作 0。
    await writeFile(join(directory, 'legacy.jsonl'), `${JSON.stringify({ seq: 0, kind: 'user', text: 'older' })}\n`);
    // 不是记录的文件不参与扫描。
    await writeFile(join(directory, 'notes.txt'), 'not a session');
    await utimes(join(directory, 'legacy.jsonl'), new Date('2026-01-01'), new Date('2026-01-01'));

    const listed = await listSessions(directory);
    assert.deepEqual(listed.map((item) => item.id), ['fresh', 'legacy'], '最近动过的那一份排在前面');

    const [firstItem, legacy] = listed;
    assert.deepEqual(firstItem, {
      id: 'fresh',
      formatVersion: 1,
      projectRoot: root,
      createdAt: firstItem.createdAt,
      updatedAt: firstItem.updatedAt,
      events: 4,
      lastSeq: 3,
      mode: { name: 'full', layer: 'shipped', digest: 'aaa111' },
      name: '',
      archived: false,
      // 那一次 `exec` 派发留在记录里没有结果：列表上就看得见这一份没收尾。
      unanswered: 1,
      truncatedBytes: 0,
    });
    assert.deepEqual({ ...legacy, updatedAt: 'x' }, {
      id: 'legacy',
      formatVersion: 0,
      projectRoot: '',
      createdAt: null,
      updatedAt: 'x',
      events: 1,
      lastSeq: 0,
      mode: null,
      name: '',
      archived: false,
      unanswered: 0,
      truncatedBytes: 0,
    });

    assert.deepEqual(await listSessions(directory, { projectRoot: 'nowhere' }), []);
    assert.deepEqual((await listSessions(directory, { projectRoot: root })).map((item) => item.id), ['fresh']);
    assert.deepEqual((await listSessions(join(root, 'nothing-here'))), [], '还没有任何记录不是错误');
  });
});

// 名字与归档标记是记录里的那几条 `label`：后写的盖掉前写的那一件，一条只说另一件时这一件沿用。
// 它也不进模型那一份：读回来的历史与发给模型的上下文是两件事（I5、实现顺序第 75 步）。
test('a label folds into the listing and stays out of what the model is shown', async () => {
  await withSessions(async (root, directory) => {
    const log = createSessionLog({ directory, id: 'named', meta: () => ({ projectRoot: root }) });
    await log.append({ kind: 'user', text: 'go' });
    await log.append({ kind: 'label', ignorable: true, name: '读数那一轮' });
    await log.append({ kind: 'label', ignorable: true, archived: true });
    assert.deepEqual((await listSessions(directory)).map((item) => [item.id, item.name, item.archived]), [['named', '读数那一轮', true]], '列表读的是那两条折出来的当前值');
    assert.deepEqual((await log.modelView()).map((row) => row.text), ['go'], '模型那一份里没有这一条事实');
  });
});

test('a search says which record a hit is in and which event it is', async () => {
  await withSessions(async (root, directory) => {
    const newer = createSessionLog({ directory, id: 'newer', meta: () => ({ projectRoot: root }) });
    await newer.append({ kind: 'label', ignorable: true, name: 'alpha 那一份' });
    await newer.append({ kind: 'tool', tool: 'exec', callId: 'c1', args: { command: 'run' }, result: { content: 'done alpha', spilled: 'result-1-abcdef12.json' } });
    // 一份长会话里一个常见词能中几十条：每份最多交三条。
    const many = createSessionLog({ directory, id: 'many', meta: () => ({ projectRoot: root }) });
    for (const line of ['alpha 一', 'alpha 二', 'alpha 三', 'alpha 四', 'alpha 五']) await many.append({ kind: 'user', text: line });
    const older = createSessionLog({ directory, id: 'older', meta: () => ({ projectRoot: root }) });
    await older.append({ kind: 'user', text: '第一段\n   alpha   第二段' });
    // 派生支线那一份不参与查：它接不回来，读它走主干那一侧（D74）。
    await writeFile(join(directory, 'newer.sub-1.jsonl'), `${JSON.stringify({ seq: 0, kind: 'user', text: 'alpha 写在支线里' })}\n`);
    // 读不出来的那一份不参与查：列表那一行已经带着稳定码说清它读不懂，这里不报第二次，也不猜它写过什么。
    await writeFile(join(directory, 'broken.jsonl'), `${JSON.stringify({ seq: 0, kind: 'nonsense' })}\n`);
    await utimes(join(directory, 'many.jsonl'), new Date('2026-01-02'), new Date('2026-01-02'));
    await utimes(join(directory, 'older.jsonl'), new Date('2026-01-01'), new Date('2026-01-01'));

    assert.deepEqual((await searchSessions(directory, { query: 'ALPHA' })).map((hit) => [hit.sessionId, hit.seq, hit.kind]), [
      ['newer', 0, 'label'], ['newer', 1, 'tool'], ['many', 0, 'user'], ['many', 1, 'user'], ['many', 2, 'user'], ['older', 0, 'user'],
    ], '最近动过的那一份先出现，一份最多三条，读不出来的那一份不交命中');

    const hits = await searchSessions(directory, { query: 'alpha' });
    assert.equal(hits[0].name, 'alpha 那一份', '命中的那一行带着这一份会话的名字');
    assert.equal(hits[1].text, 'done alpha');
    assert.equal(hits[1].spilled, 'result-1-abcdef12.json', '整段溢出在文件里时那一行说得出文件名');
    assert.equal(hits[5].text, '第一段 alpha 第二段', '正文里的换行与缩进先收拢，摘录不带半截行');
    assert.deepEqual((await searchSessions(directory, { query: '五' })).map((hit) => [hit.sessionId, hit.seq]), [['many', 4]],
      '上限管的是一份交几条，不是只读前几条');
    assert.equal((await searchSessions(directory, { query: 'alpha', limit: 2 })).length, 2);
    assert.deepEqual(await searchSessions(directory, { query: 'alpha', projectRoot: 'nowhere' }), []);
    assert.deepEqual(await searchSessions(directory, { query: '没有这段文字' }), []);
  });
});

test('a resume takes the mode the session last ran under, and a changed list is a refusal', async () => {
  const full = { name: 'full', layer: 'shipped', path: 'modes/full.toml', tools: '*', prompt: '*', digest: await digestOf('full') };

  assert.equal(chooseResumeMode({ explicit: 'minimal', recorded: { name: 'full', digest: 'stale' }, loaded: full, fallback: 'minimal' }), 'minimal',
    '--mode 写了就照它，比对不做');
  assert.equal(chooseResumeMode({ recorded: { name: 'full', digest: full.digest }, loaded: full, fallback: 'minimal' }), 'full',
    '同名同摘要：沿用那一份');
  assert.equal(chooseResumeMode({ fallback: 'minimal' }), 'minimal', '记录里从没生效过模式，就按配置与缺省来');
  // 老记录里的模式事件没有摘要这一格：无从比对，名字对得上就用。
  assert.equal(chooseResumeMode({ recorded: { name: 'full' }, loaded: full, fallback: 'minimal' }), 'full');
  assert.throws(
    () => chooseResumeMode({ recorded: { name: 'full', digest: 'old123' }, loaded: full, fallback: 'minimal' }),
    (error) => error.code === 'resume_mode_changed'
      && new RegExp(`was old123 in that session and is ${full.digest} on disk`).test(error.detail)
      && /name a mode explicitly to resume/.test(error.detail),
    '名字对得上而内容变了要报出来，不静默换成磁盘上那一份',
  );
});

const provider = {
  capabilities: MESSAGES_CAPABILITIES,
  model: 'test-model',
  async *stream() {
    yield { type: 'text', text: 'ok' };
  },
};

// 第 44 步：列表与恢复这两件事都从宿主那一边出去，界面不必自己去读记录目录，也不必自己算那一份模式清单。
async function withHost(root, run) {
  const config = createConfig({
    user: {
      boundary: root,
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
      policy: { mode: 'auto' },
    },
  });
  const pair = createMemoryConnectionPair();
  // 装配那一份带着 full：打开记录时换成哪一份，是宿主按那一份记录定的，不是这里给的这一个名字。
  const host = serveHost({
    input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy,
    modeName: 'full', modePaths: modeDirectories(root, shippedModes, join(root, 'home')),
  });
  const connection = createConnection(pair.client);
  try {
    return await run(connection, host);
  } finally {
    pair.client.output.end();
    await host.release();
  }
}

test('the host hands out the listing and resumes under the mode that record last ran', async () => {
  await withSessions(async (root, directory) => {
    const modePaths = modeDirectories(root, shippedModes, join(root, 'home'));
    const minimal = await loadMode('minimal', modePaths);
    const ran = createSessionLog({ directory, id: 'ran', meta: { projectRoot: root } });
    await ran.append({ kind: 'mode', name: 'minimal', layer: 'shipped', path: minimal.path, tools: minimal.tools, digest: minimal.digest });
    await ran.append({ kind: 'user', text: 'go' });
    // 那一份 TOML 在跑过之后被人改过一个字：记录里的摘要与磁盘上的对不上。
    const moved = createSessionLog({ directory, id: 'moved', meta: { projectRoot: root } });
    await moved.append({ kind: 'mode', name: 'minimal', layer: 'shipped', path: minimal.path, tools: minimal.tools, digest: 'stale111' });
    await moved.append({ kind: 'user', text: 'go' });

    await withHost(root, async (connection) => {
      const listed = await connection.request('sessions.list', {});
      assert.deepEqual(listed.sessions.map((item) => item.id).sort(), ['moved', 'ran'], '两份都在，界面不用自己扫那一份目录');
      assert.equal(listed.sessions.every((item) => item.mode?.name === 'minimal'), true, '列表里带着各自最后生效的那一份模式清单');
      assert.equal((await connection.request('sessions.list', { projectRoot: root })).sessions.length, 2, '按项目根过滤留下这个根下的那两份');
      assert.deepEqual((await connection.request('sessions.list', { projectRoot: 'nowhere' })).sessions, []);
      assert.equal((await connection.request('sessions.list', { limit: 1 })).sessions.length, 1);
      await assert.rejects(connection.request('sessions.list', { limit: 0 }), (error) => error.code === 'protocol_args_invalid',
        '条数写 0 是自己跟自己矛盾，不接');

      // 宿主装配时带着 full，打开那一份记录时用的却是记录里最后生效的 minimal（D78）。
      await connection.request('session.open', { sessionId: 'ran' });
      assert.equal((await connection.request('status.get', { sessionId: 'ran' })).mode, 'minimal');
      // 摘要变了要在这里报出来，让客户端指名一份再来——不静默换成磁盘上现在那一份，也不静默退回缺省。
      await assert.rejects(connection.request('session.open', { sessionId: 'moved' }),
        (error) => error.code === 'resume_mode_changed' && /name a mode explicitly to resume/.test(error.detail));
    });

    // 客户端指名了一份就照那一份，记录里那条不再比对。
    await withHost(root, async (connection) => {
      await connection.request('session.open', { sessionId: 'ran', mode: 'full' });
      assert.equal((await connection.request('status.get', { sessionId: 'ran' })).mode, 'full');
    });
  });
});

test('the listing reports a crash tail without changing it or blocking another session', async () => {
  await withTuiHost(async ({ client, sessionId, sessionDirectory }) => {
    const other = (await client.request('session.create', {})).sessionId;
    await client.request('run.start', { sessionId, input: 'first session' });
    await client.request('run.start', { sessionId: other, input: 'other session' });
    const path = join(sessionDirectory, `${sessionId}.jsonl`);
    await appendFile(path, '{"kind":"user"');
    const before = await readFile(path);

    const listed = await client.request('sessions.list', {});
    assert.deepEqual(new Set(listed.sessions.map((item) => item.id)), new Set([sessionId, other]));
    assert.equal(listed.sessions.find((item) => item.id === sessionId).truncatedBytes, Buffer.byteLength('{"kind":"user"'));
    assert.deepEqual(await readFile(path), before);
  });
});

test('one Host preserves A, B, then A session state', async () => {
  await withTuiHost(async ({ client, sessionId: sessionA }) => {
    await client.request('mode.set', { sessionId: sessionA, name: 'full' });
    assert.equal((await client.request('status.get', { sessionId: sessionA })).mode, 'full');
    const sessionB = (await client.request('session.create', {})).sessionId;
    await client.request('run.start', { sessionId: sessionA, input: 'A first' });
    const beforeSwitch = await client.request('status.get', { sessionId: sessionA });
    await client.request('run.start', { sessionId: sessionB, input: 'B only' });
    await client.request('mode.set', { sessionId: sessionB, name: 'full' });
    await client.request('session.open', { sessionId: sessionA, mode: 'minimal' });
    const afterSwitch = await client.request('status.get', { sessionId: sessionA });
    assert.equal(afterSwitch.eventCount, beforeSwitch.eventCount + 1, '显式选定模式只给这份会话增加一条 mode 事件');
    assert.equal(afterSwitch.mode, 'minimal');
    await client.request('run.start', { sessionId: sessionA, input: 'A again' });
    const { events } = await client.request('session.read', { sessionId: sessionA });
    assert.deepEqual(events.filter((event) => event.kind === 'user').map((event) => event.text), ['A first', 'A again']);
  });
});
