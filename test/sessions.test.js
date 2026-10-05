// 第 34 步的验收（D73、D78）：列表从记录目录扫出来，恢复用记录里最后生效的那份模式清单并比摘要。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  chooseResumeMode, createConfig, createConnection, createMemoryConnectionPair, createSessionLog, listSessions,
  loadMode, MESSAGES_CAPABILITIES, modeDirectories, serveHost, sessionDirectory,
} from '../dist/index.js';

const shippedModes = fileURLToPath(new URL('../modes/', import.meta.url));

// 摘要由 `loadMode` 算出来，这里只取一份真实值用于比对。
async function digestOf(name) {
  return (await loadMode(name, { shipped: shippedModes, user: join('a', 'b'), project: join('c', 'd') })).digest;
}

async function withSessions(run) {
  const root = await mkdtemp(join(tmpdir(), 'ligule-sessions-'));
  const directory = join(root, '.ligule', 'sessions');
  await mkdir(directory, { recursive: true });
  try {
    return await run(root, directory);
  } finally {
    await rm(root, { recursive: true, force: true });
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
      // 那一次 `exec` 派发留在记录里没有结果：列表上就看得见这一份没收尾。
      unanswered: 1,
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
      unanswered: 0,
    });

    assert.deepEqual(await listSessions(directory, { projectRoot: 'nowhere' }), []);
    assert.deepEqual((await listSessions(directory, { projectRoot: root })).map((item) => item.id), ['fresh']);
    assert.deepEqual((await listSessions(join(root, 'nothing-here'))), [], '还没有任何记录不是错误');
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
    host.release();
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
