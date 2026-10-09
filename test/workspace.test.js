// 工作区的身份与那份持久登记（D110、方案 5.5.1 与 5.5.2）：别名归成一个身份、一条身份只有一条记录、读不懂就当场拒。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { MESSAGES_CAPABILITIES, createConfig, createConnection, createMemoryConnectionPair, serveHost } from '../dist/index.js';
import { listSessions } from '../dist/session/list.js';
import { parseRegistry, readRegistry, registerWorkspace, workspaceIdentity } from '../dist/kernel/workspace.js';

/** 临时根里真建一个目录：身份读的是磁盘上那一份，夹具就得是真的。 */
async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), 'ligule-ws-'));
  const directory = join(root, 'Workspace One');
  await mkdir(directory);
  try {
    return await run(directory, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('同一个目录的多种写法归成同一个身份', async () => {
  await withWorkspace(async (directory) => {
    const identity = workspaceIdentity(directory);
    assert.equal(workspaceIdentity(`${directory}${sep}`), identity, '尾部分隔符不算另一个目录');
    assert.equal(workspaceIdentity(join(directory, '..', 'Workspace One')), identity, '折上去再折回来还是同一个目录');
    assert.equal(workspaceIdentity(join(directory, '.')), identity, '中间那一段 . 不算另一个目录');
    if (process.platform === 'win32') {
      assert.equal(workspaceIdentity(directory.toUpperCase()), identity, '盘符与路径的大小写不影响身份');
      assert.equal(workspaceIdentity(directory.split(sep).join('/')), identity, '正斜杠与反斜杠是同一个目录的两种写法');
    } else {
      const link = `${directory}-link`;
      try {
        await symlink(directory, link);
        assert.equal(workspaceIdentity(link), identity, '链接指向的那一个目录就是它自己');
      } catch {
        // 这台机器上没给建符号链接的权限：这一格跳过，其余三条已经覆盖归一。
      }
    }
  });
});

test('空的那一格拒掉，不在那儿的目录交回一个绝对身份', () => {
  assert.throws(() => workspaceIdentity('   '), (error) => error.code === 'workspace_directory_required');
  const far = join(process.cwd(), 'not-there-yet');
  const expected = process.platform === 'win32' ? resolve(far).toLowerCase() : resolve(far);
  assert.equal(workspaceIdentity(far), expected, '目录不在不等于回退到程序目录或启动目录');
});

test('同一具工作区登记两次只有一条，第一次看见的时间留着', async () => {
  await withWorkspace(async (directory, root) => {
    const path = join(root, 'workspaces.json');
    const first = await registerWorkspace(directory, { path, now: '2026-10-01T00:00:00.000Z' });
    assert.equal(first.workspaces.length, 1);
    assert.equal(first.workspaces[0].name, 'Workspace One', '没指名就用目录那一段做显示名');
    const second = await registerWorkspace(join(directory, '.'), { path, name: '改过的名字', now: '2026-10-02T00:00:00.000Z' });
    assert.equal(second.workspaces.length, 1, '别名不再登记第二条');
    assert.equal(second.workspaces[0].firstSeen, '2026-10-01T00:00:00.000Z');
    assert.equal(second.workspaces[0].lastSeen, '2026-10-02T00:00:00.000Z');
    assert.equal(second.workspaces[0].name, '改过的名字');
    const onDisk = await readRegistry(path);
    assert.deepEqual(onDisk.workspaces, second.workspaces);
    assert.equal(onDisk.default, null, '默认选择由界面那一侧写，登记这一处不动它');
  });
});

test('那份登记读不懂就当场拒，不当成空的', () => {
  assert.throws(() => parseRegistry('{'), (error) => error.code === 'workspace_registry_invalid');
  assert.throws(() => parseRegistry(JSON.stringify({ version: 2, default: null, workspaces: [] })), (error) => error.code === 'workspace_registry_version');
  assert.throws(() => parseRegistry(JSON.stringify({ version: 1, default: 'nope', workspaces: [] })), (error) => error.code === 'workspace_registry_invalid', '默认选择指向一个没登记的身份');
  assert.throws(() => parseRegistry(JSON.stringify({ version: 1, default: null, workspaces: [{ identity: 'a' }] })), (error) => error.code === 'workspace_registry_invalid', '一条记录少了字段就是少了');
  const readable = parseRegistry(JSON.stringify({ version: 1, default: 'a', workspaces: [{ identity: 'a', directory: 'A', name: 'a', firstSeen: 'x', lastSeen: 'y' }] }));
  assert.equal(readable.default, 'a');
});

// 宿主那一条路：真的建了一份会话，那一具工作区就进了登记，位置在应用数据根里，记录首行也带上身份与来源。
test('建会话的那一侧把这一具工作区登记进应用数据根，并把身份与来源写进首行', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ligule-ws-home-'));
  const project = await mkdtemp(join(tmpdir(), 'ligule-ws-proj-'));
  const previous = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = home;
  const pair = createMemoryConnectionPair();
  let host;
  try {
    const config = createConfig({ user: { boundary: project, model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' } } });
    const provider = { capabilities: MESSAGES_CAPABILITIES, model: 'test-model', async *stream() { yield { type: 'text', text: 'ok' }; } };
    host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy });
    const connection = createConnection(pair.client);
    const { sessionId } = await connection.request('session.create', {});
    await connection.request('run.start', { sessionId, input: '第一轮' });
    const registry = await readRegistry();
    assert.equal(registry.workspaces.length, 1);
    assert.equal(registry.workspaces[0].identity, workspaceIdentity(project));
    assert.equal(registry.workspaces[0].name, basename(project), '登记里的显示名是那一段目录名');
    const lines = await readFile(join(project, '.ligule', 'sessions', `${sessionId}.jsonl`), 'utf8');
    const header = JSON.parse(lines.split('\n')[0]);
    assert.equal(header.workspace, workspaceIdentity(project), '首行记下这一份会话落在哪一具工作区');
    assert.equal(header.workspaceOrigin, 'default', '客户端没指名项目根，来源就是它当前那一具');
    const [listed] = await listSessions(join(project, '.ligule', 'sessions'), { projectRoot: project });
    assert.equal(listed.workspace, header.workspace, '列表把这两格一起交出去，界面分组读它而不是读路径相等');
    assert.equal(listed.workspaceOrigin, 'default');
  } finally {
    pair.client.output.end();
    if (host !== undefined) await host.release();
    if (previous === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previous;
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});
