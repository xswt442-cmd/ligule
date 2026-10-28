import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deleteTool } from '../dist/index.js';

test('delete reports operating-system recycle failure and preserves files and directory contents', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'recycle-failure-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const target = join(workspace, 'keep.txt');
  await writeFile(target, 'keep me');
  const directory = join(workspace, 'keep-directory');
  await mkdir(join(directory, 'nested'), { recursive: true });
  await writeFile(join(directory, 'nested', 'keep.txt'), 'keep directory contents');
  const config = { boundary: workspace, workspaceRoot: workspace };
  const previousXdgData = process.env.XDG_DATA_HOME;
  try {
    if (process.platform === 'linux') {
      const blockedXdgData = join(root, 'xdg-data-is-a-file');
      await writeFile(blockedXdgData, 'not a directory');
      process.env.XDG_DATA_HOME = blockedXdgData;
      for (const path of ['keep.txt', 'keep-directory']) {
        await assert.rejects(deleteTool.run({ path }, { config }), { code: 'recycle_backend_missing' });
      }
    } else if (process.platform === 'win32') {
      const koffi = (await import('koffi')).default;
      const kernel = koffi.load('kernel32.dll');
      const createFile = kernel.func('__stdcall', 'CreateFileW', 'intptr', [
        'str16', 'uint32_t', 'uint32_t', 'intptr', 'uint32_t', 'uint32_t', 'intptr',
      ]);
      const closeHandle = kernel.func('__stdcall', 'CloseHandle', 'int32_t', ['intptr']);
      for (const [path, nativePath, flags] of [
        ['keep.txt', target, 0x00000080],
        ['keep-directory', directory, 0x02000000],
      ]) {
        const handle = createFile(nativePath, 0x80000000, 0x00000003, 0, 3, flags, 0);
        assert.notEqual(handle, -1);
        assert.notEqual(handle, -1n);
        try {
          await assert.rejects(deleteTool.run({ path }, { config }), { code: 'recycle_backend_failed' });
        } finally {
          assert.equal(closeHandle(handle), 1);
        }
      }
    } else {
      for (const path of ['keep.txt', 'keep-directory']) {
        await assert.rejects(deleteTool.run({ path }, { config }), { code: 'recycle_backend_missing' });
      }
    }
    assert.equal(await readFile(target, 'utf8'), 'keep me');
    assert.equal(await readFile(join(directory, 'nested', 'keep.txt'), 'utf8'), 'keep directory contents');
    await assert.rejects(lstat(join(workspace, '.ligule-trash')), { code: 'ENOENT' });
  } finally {
    if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgData;
    await rm(root, { recursive: true, force: true });
  }
});
