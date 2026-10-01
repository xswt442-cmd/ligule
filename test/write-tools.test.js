import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createConfig, createKernel, createObservationLog, createTool, deleteTool, editTool, readTool, readOnlyTools,
  writeTool, writeTools,
} from '../src/index.js';

async function withWorkspace(run) {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'write-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  try {
    return await run(workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function context(workspace, limits) {
  return { config: { boundary: workspace, limits } };
}

test('create writes a new file and creates the missing parent directories', async () => {
  await withWorkspace(async (workspace) => {
    assert.deepEqual(await createTool.run({ path: 'src/deep/new.txt', content: 'hello' }, context(workspace)), {
      text: 'created src/deep/new.txt (5 bytes)',
    });
    assert.equal(await readFile(join(workspace, 'src', 'deep', 'new.txt'), 'utf8'), 'hello');
  });
});

test('create refuses an existing target and leaves its content alone', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'original');
    await assert.rejects(
      () => createTool.run({ path: 'note.txt', content: 'overwritten' }, context(workspace)),
      (error) => error.code === 'create_target_exists',
    );
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'original');
  });
});

test('edit replaces the one occurrence the anchor locates', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'one\ntwo\nthree');
    assert.deepEqual(await editTool.run({ path: 'note.txt', anchor: 'two', replacement: '2' }, context(workspace)), {
      text: 'edited note.txt',
    });
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'one\n2\nthree');
  });
});

test('edit rejects an empty or blank anchor before looking at the file', async () => {
  await withWorkspace(async (workspace) => {
    for (const anchor of ['', '   ']) {
      await assert.rejects(
        () => editTool.run({ path: 'missing.txt', anchor, replacement: 'x' }, context(workspace)),
        (error) => error.code === 'edit_anchor_empty',
      );
    }
  });
});

test('edit rejects a missing target, an anchor that is not there, and an anchor that matches twice', async () => {
  await withWorkspace(async (workspace) => {
    await assert.rejects(
      () => editTool.run({ path: 'missing.txt', anchor: 'a', replacement: 'b' }, context(workspace)),
      (error) => error.code === 'edit_target_missing',
    );
    await writeFile(join(workspace, 'note.txt'), 'alpha');
    await assert.rejects(
      () => editTool.run({ path: 'note.txt', anchor: 'zzz', replacement: 'b' }, context(workspace)),
      (error) => error.code === 'edit_anchor_not_found',
    );
    await writeFile(join(workspace, 'twice.txt'), 'x x');
    await assert.rejects(
      () => editTool.run({ path: 'twice.txt', anchor: 'x', replacement: 'y' }, context(workspace)),
      (error) => error.code === 'edit_anchor_ambiguous',
    );
    assert.equal(await readFile(join(workspace, 'twice.txt'), 'utf8'), 'x x');
  });
});

test('delete moves the file into the trash directory instead of removing it', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'keep me');
    assert.deepEqual(await deleteTool.run({ path: 'note.txt' }, context(workspace)), {
      text: 'moved note.txt into .ligule-trash',
    });
    await assert.rejects(() => readFile(join(workspace, 'note.txt'), 'utf8'), (error) => error.code === 'ENOENT');
    const trashed = await readdir(join(workspace, '.ligule-trash'));
    assert.equal(trashed.length, 1);
    assert.match(trashed[0], /^\d{13}-[0-9a-f]{8}--note\.txt$/);
    assert.equal(await readFile(join(workspace, '.ligule-trash', trashed[0]), 'utf8'), 'keep me');
  });
});

test('delete refuses the boundary itself and a target that is not there', async () => {
  await withWorkspace(async (workspace) => {
    await assert.rejects(
      () => deleteTool.run({ path: '.' }, context(workspace)),
      (error) => error.code === 'delete_target_is_boundary',
    );
    await assert.rejects(
      () => deleteTool.run({ path: 'gone.txt' }, context(workspace)),
      (error) => error.code === 'delete_target_missing',
    );
  });
});

// 观察记录由内核注入，这里按内核给的形状自己建一份，直接调工具。
function observed(workspace, limits) {
  const observations = createObservationLog();
  return { config: { boundary: workspace, limits }, observations };
}

test('write replaces the whole content of a file observed in this run', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'one\ntwo');
    const context = observed(workspace);
    await readTool.run({ path: 'note.txt' }, context);
    assert.deepEqual(await writeTool.run({ path: 'note.txt', content: 'replaced' }, context), {
      text: 'wrote note.txt (8 bytes)',
    });
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'replaced');
    // 写成功之后重新登记，紧接着再覆盖一次不要求重新读。
    assert.deepEqual(await writeTool.run({ path: 'note.txt', content: 'again' }, context), {
      text: 'wrote note.txt (5 bytes)',
    });
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'again');
  });
});

test('write refuses an unobserved target, one that changed since, and one that is not there', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'one\ntwo');
    const context = observed(workspace);
    await assert.rejects(
      () => writeTool.run({ path: 'note.txt', content: 'x' }, context),
      (error) => error.code === 'write_not_observed',
    );
    await readTool.run({ path: 'note.txt' }, context);
    await writeFile(join(workspace, 'note.txt'), 'changed behind our back');
    await assert.rejects(
      () => writeTool.run({ path: 'note.txt', content: 'x' }, context),
      (error) => error.code === 'write_version_stale',
    );
    await assert.rejects(
      () => writeTool.run({ path: 'missing.txt', content: 'x' }, context),
      (error) => error.code === 'write_target_missing',
    );
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'changed behind our back');
  });
});

test('a truncated read is not an observation, so it cannot authorise an overwrite', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'a'.repeat(40));
    const context = observed(workspace, { readBytes: 10 });
    assert.match((await readTool.run({ path: 'note.txt' }, context)).text, /truncated/);
    await assert.rejects(
      () => writeTool.run({ path: 'note.txt', content: 'x' }, context),
      (error) => error.code === 'write_not_observed',
    );
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'a'.repeat(40));
  });
});

test('a successful edit refreshes the observation and a delete drops it', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'one\ntwo');
    const context = observed(workspace);
    await readTool.run({ path: 'note.txt' }, context);
    await editTool.run({ path: 'note.txt', anchor: 'two', replacement: '2' }, context);
    assert.deepEqual(await writeTool.run({ path: 'note.txt', content: 'after edit' }, context), {
      text: 'wrote note.txt (10 bytes)',
    });

    await deleteTool.run({ path: 'note.txt' }, context);
    await createTool.run({ path: 'note.txt', content: 'after edit' }, context);
    // create 自己登记了这一次的内容，所以紧接着覆盖成立；换成别的进程写的文件就不成立。
    assert.deepEqual(await writeTool.run({ path: 'note.txt', content: 'x' }, context), { text: 'wrote note.txt (1 bytes)' });
  });
});

test('write goes through the kernel and its failures reach the session log', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'one');
    const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }) });
    kernel.register(readTool);
    kernel.register(writeTool);
    await assert.rejects(
      () => kernel.call('write', { path: 'note.txt', content: 'x' }),
      (error) => error.code === 'write_not_observed',
    );
    await kernel.call('read', { path: 'note.txt' });
    assert.deepEqual(await kernel.call('write', { path: 'note.txt', content: 'two' }), { text: 'wrote note.txt (3 bytes)' });
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'two');
  });
});

test('the seven tools satisfy the registration contract and all reach the manifest', () => {
  const kernel = createKernel();
  for (const tool of [...readOnlyTools, ...writeTools]) kernel.register(tool);
  assert.deepEqual(kernel.list(), ['create', 'delete', 'edit', 'find', 'read', 'search', 'write']);
  for (const entry of kernel.manifest()) {
    assert.deepEqual(Object.keys(entry).sort(), ['description', 'name', 'parameters']);
  }
});
