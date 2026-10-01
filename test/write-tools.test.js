import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createConfig, createKernel, createObservationLog, createTool, deleteTool, editTool, freedesktopTrash, readTool,
  readOnlyTools, resolveRecycler, writeTool, writeTools,
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

// 日志接口与观察记录都由内核注入，这里按内核给的形状自己建一份，直接调工具。
const silentLogger = { debug: () => {}, log: () => {} };

function context(workspace, limits, extra) {
  return { config: { boundary: workspace, limits, ...extra }, logger: silentLogger };
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
    assert.deepEqual(await deleteTool.run({ path: 'note.txt' }, context(workspace, undefined, { trashBackend: 'managed' })), {
      text: 'moved note.txt into .ligule-trash',
    });
    await assert.rejects(() => readFile(join(workspace, 'note.txt'), 'utf8'), (error) => error.code === 'ENOENT');
    const trashed = await readdir(join(workspace, '.ligule-trash'));
    assert.equal(trashed.length, 1);
    assert.match(trashed[0], /^\d{13}-[0-9a-f]{8}--note\.txt$/);
    assert.equal(await readFile(join(workspace, '.ligule-trash', trashed[0]), 'utf8'), 'keep me');
  });
});

test('delete with the default backend takes the file out of the workspace and says where it went', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'keep me');
    // 这一条走的是这台机器上真正生效的那一条后端：在 Windows 上它会送进系统回收站，
    // 在 Linux 上送进 freedesktop 的 Trash，两者都不在断言里钉死，钉死的是「文件离开了工作区」与「交回的说法」。
    const result = await deleteTool.run({ path: 'note.txt' }, context(workspace));
    assert.match(result.text, /^(sent note\.txt to the (system recycle bin|freedesktop trash)|moved note\.txt into \.ligule-trash)$/);
    await assert.rejects(() => readFile(join(workspace, 'note.txt'), 'utf8'), (error) => error.code === 'ENOENT');
  });
});

test('an unknown trash backend is refused with a code', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'keep me');
    await assert.rejects(
      () => deleteTool.run({ path: 'note.txt' }, context(workspace, undefined, { trashBackend: 'shred' })),
      (error) => error.code === 'delete_trash_backend_unknown',
    );
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'keep me');
  });
});

test('a platform without a backend resolves to no recycler and a stable code', async () => {
  assert.deepEqual(await resolveRecycler('darwin'), { recycler: undefined, code: 'recycle_backend_missing' });
});

test('the freedesktop backend writes the info file the spec asks for and counts name collisions', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'trash-'));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(root, 'data');
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'note.txt'), 'keep me');
    await freedesktopTrash.probe();
    await freedesktopTrash.send(join(workspace, 'note.txt'));

    const files = join(root, 'data', 'Trash', 'files');
    assert.equal(await readFile(join(files, 'note.txt'), 'utf8'), 'keep me');
    const info = await readFile(join(root, 'data', 'Trash', 'info', 'note.txt.trashinfo'), 'utf8');
    const [header, pathLine, dateLine] = info.trimEnd().split('\n');
    assert.equal(header, '[Trash Info]');
    assert.equal(pathLine, `Path=${join(workspace, 'note.txt').split('/').map(encodeURIComponent).join('/')}`);
    assert.match(dateLine, /^DeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

    // 同名再来一次：回收站里那一份不被覆盖，新的那一份按规范往后加计数。
    await writeFile(join(workspace, 'note.txt'), 'second');
    await freedesktopTrash.send(join(workspace, 'note.txt'));
    assert.deepEqual((await readdir(files)).sort(), ['note.txt', 'note.txt.1']);
    assert.equal(await readFile(join(files, 'note.txt'), 'utf8'), 'keep me');
    assert.equal(await readFile(join(files, 'note.txt.1'), 'utf8'), 'second');
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
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

function observed(workspace, limits) {
  const observations = createObservationLog();
  // 删除钉在项目内那个目录上：这一组测试要看的是观察记录，不该把文件送进系统回收站。
  return { config: { boundary: workspace, limits, trashBackend: 'managed' }, logger: silentLogger, observations };
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
