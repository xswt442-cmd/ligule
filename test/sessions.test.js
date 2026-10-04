// 第 34 步的验收（D73、D78）：列表从记录目录扫出来，恢复用记录里最后生效的那份模式清单并比摘要。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chooseResumeMode, createSessionLog, listSessions, loadMode, sessionDirectory } from '../dist/index.js';

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
      && /pass --mode to choose/.test(error.detail),
    '名字对得上而内容变了要报出来，不静默换成磁盘上那一份',
  );
});
