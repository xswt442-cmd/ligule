import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanSystemTrashEntry } from './helpers/system-trash.js';
import { deleteTool, resolveRecycler } from '../dist/index.js';

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test('delete reports real system trash failures or verifies successful Linux trash entries', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'recycle-failure-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const fileName = `keep-${randomUUID()}.txt`;
  const directoryName = `keep-directory-${randomUUID()}`;
  const target = join(workspace, fileName);
  await writeFile(target, 'keep me');
  const directory = join(workspace, directoryName);
  await mkdir(join(directory, 'nested'), { recursive: true });
  await writeFile(join(directory, 'nested', 'keep.txt'), 'keep directory contents');
  const cases = [
    { path: fileName, target, type: 'file', content: 'keep me' },
    { path: directoryName, target: directory, type: 'directory', content: 'keep directory contents' },
  ];
  const config = { boundary: workspace, workspaceRoot: workspace };
  const previousXdgData = process.env.XDG_DATA_HOME;
  try {
    if (process.platform === 'linux') {
      assert.ok((await resolveRecycler()).recycler, 'GIO is available before the send operation starts');
      const blockedXdgData = join(root, 'xdg-data-is-a-file');
      await writeFile(blockedXdgData, 'not a directory');
      process.env.XDG_DATA_HOME = blockedXdgData;
      for (const item of cases) {
        let failure;
        try { await deleteTool.run({ path: item.path }, { config }); }
        catch (error) { failure = error; }
        if (failure !== undefined) {
          assert.equal(failure.code, 'recycle_backend_failed');
          if (item.type === 'file') assert.equal(await readFile(item.target, 'utf8'), item.content);
          else assert.equal(await readFile(join(item.target, 'nested', 'keep.txt'), 'utf8'), item.content);
        } else {
          await assert.rejects(lstat(item.target), { code: 'ENOENT' });
          await cleanSystemTrashEntry(item.target, item, { required: true });
        }
      }
    } else if (process.platform === 'win32') {
      const koffi = (await import('koffi')).default;
      const kernel = koffi.load('kernel32.dll');
      const createFile = kernel.func('__stdcall', 'CreateFileW', 'intptr', [
        'str16', 'uint32_t', 'uint32_t', 'intptr', 'uint32_t', 'uint32_t', 'intptr',
      ]);
      const closeHandle = kernel.func('__stdcall', 'CloseHandle', 'int32_t', ['intptr']);
      for (const [path, nativePath, flags] of [
        [fileName, target, 0x00000080],
        [directoryName, directory, 0x02000000],
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
      for (const item of cases) {
        await assert.rejects(deleteTool.run({ path: item.path }, { config }), { code: 'recycle_backend_missing' });
      }
    }
    if (await exists(target)) {
      assert.equal(await readFile(target, 'utf8'), 'keep me');
    }
    if (await exists(directory)) {
      assert.equal(await readFile(join(directory, 'nested', 'keep.txt'), 'utf8'), 'keep directory contents');
    }
    await assert.rejects(lstat(join(workspace, '.ligule-trash')), { code: 'ENOENT' });
  } finally {
    if (process.platform === 'linux') {
      await cleanSystemTrashEntry(target, cases[0]);
      await cleanSystemTrashEntry(directory, cases[1]);
    }
    if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgData;
    await rm(root, { recursive: true, force: true });
  }
});
