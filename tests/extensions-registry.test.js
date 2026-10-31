// 扩展启停登记：可信界面经 extensions.set 写入数据根的登记文件，
// 名称必须对应安装目录中的扩展；登记在下次 Host 启动时生效。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { withTuiHost } from '../core/tests/helpers/tui-host.js';

test('extensions.set records the disable registry from a trusted interface', async () => {
  // 注入的扩展源模拟安装目录发现结果；登记文件写在当前隔离数据根下。
  const home = await mkdtemp(join(tmpdir(), 'ligule-extension-state-'));
  const soloPath = resolve(join(home, '.ligule', 'extensions', 'solo.js'));
  await mkdir(join(home, '.ligule', 'extensions'), { recursive: true });
  await writeFile(soloPath, 'export default () => () => {};\n', 'utf8');
  try {
    await withTuiHost(async ({ client, projectDirectory }) => {
      const catalog = await client.request('settings.catalog', { projectRoot: projectDirectory });
      const entry = catalog.extensions.find((item) => item.name === 'solo');
      assert.ok(entry, '注入的扩展出现在清单里');
      assert.equal(entry.enabled, true);
      assert.equal(entry.source, 'user-configured');

      const done = await client.request('extensions.set', { projectRoot: projectDirectory, name: 'solo', enabled: false });
      assert.deepEqual([done.name, done.enabled, done.applies], ['solo', false, 'next-start']);
      const statePath = join(homedir(), '.ligule', 'extensions-state.json');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      assert.deepEqual(state, { version: 1, disabled: ['solo'] });

      const restored = await client.request('extensions.set', { projectRoot: projectDirectory, name: 'solo', enabled: true });
      assert.equal(restored.enabled, true);
      const after = JSON.parse(await readFile(statePath, 'utf8'));
      assert.deepEqual(after.disabled, [], '重新启用后登记清空');

      await assert.rejects(
        client.request('extensions.set', { projectRoot: projectDirectory, name: 'ghost', enabled: false }),
        (error) => error.code === 'extensions_set_unknown', '未知名称点名拒绝',
      );
    }, {
      permissionControl: true,
      extensions: { paths: [soloPath], ignored: [], installNames: { [soloPath]: 'solo' } },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
