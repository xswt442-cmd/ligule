import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConfig, flagLayer, loadConfigLayers } from '../dist/index.js';

// 用户主目录与项目根都建在 testplace/ 下的临时目录里：装载侧读哪三份文件由这两个根决定，
// 测试因此不碰真实的 ~/.ligule，也不依赖进程环境。
async function withLayers(run) {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'config-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await mkdir(join(home, '.ligule'), { recursive: true });
  await mkdir(join(project, '.ligule'), { recursive: true });
  try {
    return await run({ home, project });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 这两条都走真实的文件与折叠那一条路：项目层那一份可能出自别人写的仓库，日期时间是 TOML 里正当的写法。
test('a project file holding a __proto__ table is refused when the layers fold', async () => {
  await withLayers(async ({ home, project }) => {
    await writeFile(join(project, '.ligule', 'config.toml'), '["__proto__"]\npolluted = 1\n');
    const layers = await loadConfigLayers({ projectRoot: project, userHome: home });
    assert.throws(() => createConfig(layers), (error) => error.code === 'config_key_unsafe');
    assert.equal({}.polluted, undefined, 'nothing reached Object.prototype');
  });
});

test('a datetime in the higher layer file replaces the lower one', async () => {
  await withLayers(async ({ home, project }) => {
    await writeFile(join(home, '.ligule', 'config.toml'), 'when = 1979-05-27T07:32:00Z\n');
    await writeFile(join(project, '.ligule', 'config.toml'), 'when = 2026-10-01T00:00:00Z\n');
    const snapshot = createConfig(await loadConfigLayers({ projectRoot: project, userHome: home }));
    assert.equal(snapshot.when.toISOString(), '2026-10-01T00:00:00.000Z');
  });
});

test('the three files fold user < project < local, tables per key and arrays whole', async () => {
  await withLayers(async ({ home, project }) => {
    await writeFile(join(home, '.ligule', 'config.toml'), 'boundary = "/from-user"\n\n[limits]\nreadBytes = 10\nresultCount = 5\nkeep = [1, 2]\n');
    await writeFile(join(project, '.ligule', 'config.toml'), '[limits]\nreadBytes = 20\nkeep = [3]\n');
    await writeFile(join(project, '.ligule', 'config.local.toml'), '[limits]\nresultCount = 7\n');
    const snapshot = createConfig(await loadConfigLayers({ projectRoot: project, userHome: home }));
    assert.equal(snapshot.boundary, '/from-user');
    assert.deepEqual(snapshot.limits, { readBytes: 20, resultCount: 7, keep: [3] });
    assert.ok(Object.isFrozen(snapshot.limits));
  });
});

test('a missing file is not an error and three missing files fold into an empty snapshot', async () => {
  await withLayers(async ({ home, project }) => {
    assert.deepEqual(createConfig(await loadConfigLayers({ projectRoot: project, userHome: home })), {});
  });
});

test('a layer that does not parse fails at once and names the layer and the file', async () => {
  await withLayers(async ({ home, project }) => {
    await writeFile(join(project, '.ligule', 'config.toml'), '= 1\n');
    await assert.rejects(
      () => loadConfigLayers({ projectRoot: project, userHome: home }),
      (error) => error.code === 'config_file_invalid'
        && error.detail.startsWith('project: ')
        && error.detail.endsWith(join('.ligule', 'config.toml')),
    );
  });
});

test('a dotted flag becomes a typed value and several flags merge per key', () => {
  assert.deepEqual(flagLayer(['limits.readBytes = 100', 'boundary = "/from-flag"', 'limits.scanFiles = 5']), {
    boundary: '/from-flag',
    limits: { readBytes: 100, scanFiles: 5 },
  });
  assert.throws(() => flagLayer(['limits.readBytes']), (error) => error.code === 'config_flag_invalid');
});

test('the flag layer wins over all three files', async () => {
  await withLayers(async ({ home, project }) => {
    await writeFile(join(project, '.ligule', 'config.local.toml'), '[limits]\nreadBytes = 20\n');
    const snapshot = createConfig(await loadConfigLayers({
      projectRoot: project,
      userHome: home,
      flags: ['limits.readBytes = 99'],
    }));
    assert.equal(snapshot.limits.readBytes, 99);
  });
});
