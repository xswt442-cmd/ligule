import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createConfig, createDecisionChain, createKernel, createObservationLog, createPermissionContext, createTool, deleteTool, editTool, freedesktopTrash, readTool,
  readOnlyTools, resolveRecycler, writeTool, writeTools,
} from '../dist/index.js';

async function withWorkspace(run) {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'write-'));
  const workspace = join(root, 'workspace');
  const previousXdgData = process.env.XDG_DATA_HOME;
  await mkdir(workspace, { recursive: true });
  process.env.XDG_DATA_HOME = join(root, 'xdg-data');
  try {
    return await run(workspace);
  } finally {
    if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgData;
    await rm(root, { recursive: true, force: true });
  }
}

// 日志接口与观察记录都由内核注入，这里按内核给的形状自己建一份，直接调工具。
const silentLogger = { debug: () => {}, log: () => {} };
const workspaceWrite = createPermissionContext('workspace-write', 'disabled', {
  filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
});

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

test('two kernels creating one file preserve exactly one complete winner', async () => {
  await withWorkspace(async (workspace) => {
    const kernels = [0, 1].map(() => {
      const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }), permission: workspaceWrite });
      kernel.register(createTool);
      return kernel;
    });
    const contents = ['first complete content', 'second complete content'];
    for (let index = 0; index < 10; index += 1) {
      const path = `race-${index}.txt`;
      const outcomes = await Promise.allSettled(kernels.map((kernel, writer) => kernel.call('create', { path, content: contents[writer] })));
      assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
      const failed = outcomes.find((item) => item.status === 'rejected');
      assert.equal(failed.reason.code, 'create_target_exists');
      const winner = outcomes.findIndex((item) => item.status === 'fulfilled');
      assert.equal(await readFile(join(workspace, path), 'utf8'), contents[winner]);
    }
  });
});

test('legacy project trash settings fail with an actionable error and preserve the source', async () => {
  await withWorkspace(async (workspace) => {
    const outside = join(workspace, '..', 'outside');
    await mkdir(outside);
    await writeFile(join(workspace, 'keep.txt'), 'must remain');
    const kernel = createKernel({
      config: createConfig({ user: { boundary: workspace, trashBackend: 'managed', limits: { trashDirectory: '../outside' } } }),
      permission: workspaceWrite,
    });
    kernel.register(deleteTool);
    await assert.rejects(kernel.call('delete', { path: 'keep.txt' }), { code: 'trash_legacy_config_unsupported' });
    assert.equal(await readFile(join(workspace, 'keep.txt'), 'utf8'), 'must remain');
    assert.deepEqual(await readdir(outside), []);
  });
});

test('deletion leaves an existing unknown project trash directory untouched', async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, '.ligule-trash'));
    await writeFile(join(workspace, '.ligule-trash', 'old-entry.txt'), 'untouched legacy data');
    await writeFile(join(workspace, 'keep.txt'), 'must remain');
    const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }), permission: workspaceWrite });
    kernel.register(deleteTool);
    // The test process may have a working system trash. In either case the old directory is never adopted or altered.
    await kernel.call('delete', { path: 'keep.txt' });
    assert.equal(await readFile(join(workspace, '.ligule-trash', 'old-entry.txt'), 'utf8'), 'untouched legacy data');
    assert.deepEqual((await readdir(join(workspace, '.ligule-trash'))).sort(), ['old-entry.txt']);
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

test('edit preserves replacement tokens as literal file content through the kernel', async () => {
  await withWorkspace(async (workspace) => {
    const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }), permission: workspaceWrite });
    kernel.register(createTool);
    kernel.register(editTool);
    await kernel.call('create', { path: 'literal.txt', content: 'before ANCHOR after' });
    const replacement = "$& $$ $` $'\nconst value = '$&';";
    await kernel.call('edit', { path: 'literal.txt', anchor: 'ANCHOR', replacement });
    assert.equal(await readFile(join(workspace, 'literal.txt'), 'utf8'), `before ${replacement} after`);
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

test('delete refuses a final directory link and preserves its target', async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, 'source'));
    await writeFile(join(workspace, 'source', 'keep.txt'), 'keep the source');
    await symlink(join(workspace, 'source'), join(workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }), permission: workspaceWrite });
    kernel.register(deleteTool);
    for (const path of ['alias', 'alias/']) {
      await assert.rejects(kernel.call('delete', { path }), { code: 'delete_target_is_link' });
      assert.equal((await lstat(join(workspace, 'alias'))).isSymbolicLink(), true);
      assert.equal(await readFile(join(workspace, 'source', 'keep.txt'), 'utf8'), 'keep the source');
    }
    assert.deepEqual((await readdir(workspace)).sort(), ['alias', 'source']);
  });
});

test('delete refuses a dangling directory link without replacing it', async () => {
  await withWorkspace(async (workspace) => {
    const source = join(workspace, 'source');
    await mkdir(source);
    await symlink(source, join(workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await rm(source, { recursive: true });
    const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }), permission: workspaceWrite });
    kernel.register(deleteTool);
    await assert.rejects(kernel.call('delete', { path: 'alias' }), { code: 'delete_target_is_link' });
    assert.equal((await lstat(join(workspace, 'alias'))).isSymbolicLink(), true);
    assert.deepEqual(await readdir(workspace), ['alias']);
  });
});

test('delete uses the operating system recycle bin and takes the source out of the workspace', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'keep me');
    const approvals = [];
    const kernel = createKernel({
      config: createConfig({ user: { boundary: workspace } }),
      permission: workspaceWrite,
      policy: createDecisionChain({ mode: 'ask', ask: async (question) => {
        approvals.push(question);
        return { decision: 'allow', source: 'human' };
      } }),
    });
    kernel.register(deleteTool);
    const result = await kernel.call('delete', { path: 'note.txt' });
    assert.match(result.text, /^(sent note\.txt to the (system recycle bin|freedesktop trash))$/);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].tool, 'delete');
    await assert.rejects(() => readFile(join(workspace, 'note.txt'), 'utf8'), (error) => error.code === 'ENOENT');
  });
});

test('Policy denial leaves the delete target in place', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'keep me');
    const kernel = createKernel({
      config: createConfig({ user: { boundary: workspace } }),
      permission: workspaceWrite,
      policy: createDecisionChain({ mode: 'ask', ask: async () => ({ decision: 'deny', source: 'human' }) }),
    });
    kernel.register(deleteTool);
    await assert.rejects(kernel.call('delete', { path: 'note.txt' }), { code: 'ask_declined' });
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'keep me');
  });
});

test('delete refuses a target changed while Policy approval is pending', async () => {
  await withWorkspace(async (workspace) => {
    const target = join(workspace, 'note.txt');
    await writeFile(target, 'original content');
    const kernel = createKernel({
      config: createConfig({ user: { boundary: workspace } }),
      permission: workspaceWrite,
      policy: createDecisionChain({ mode: 'ask', ask: async () => {
        await writeFile(target, 'changed while waiting');
        return { decision: 'allow', source: 'human' };
      } }),
    });
    kernel.register(deleteTool);
    await assert.rejects(kernel.call('delete', { path: 'note.txt' }), { code: 'delete_target_changed' });
    assert.equal(await readFile(target, 'utf8'), 'changed while waiting');
  });
});

test('concurrent delete calls keep per-call snapshots when they share the same argument object', async () => {
  await withWorkspace(async (workspace) => {
    const target = join(workspace, 'note.txt');
    await writeFile(target, 'original content');
    let signalFirstApproval;
    let approveFirst;
    const firstApproval = new Promise((resolve) => { signalFirstApproval = resolve; });
    const firstDecision = new Promise((resolve) => { approveFirst = resolve; });
    const firstKernel = createKernel({
      config: createConfig({ user: { boundary: workspace } }),
      permission: workspaceWrite,
      policy: createDecisionChain({ mode: 'ask', ask: async () => {
        signalFirstApproval();
        return firstDecision;
      } }),
    });
    const secondKernel = createKernel({
      config: createConfig({ user: { boundary: workspace } }),
      permission: workspaceWrite,
      policy: createDecisionChain({ mode: 'ask', ask: async () => ({ decision: 'deny', source: 'human' }) }),
    });
    firstKernel.register(deleteTool);
    secondKernel.register(deleteTool);
    const sharedArguments = { path: 'note.txt' };
    const first = firstKernel.call('delete', sharedArguments);
    await firstApproval;
    await rm(target);
    await writeFile(target, 'replacement during first approval');
    await assert.rejects(secondKernel.call('delete', sharedArguments), { code: 'ask_declined' });
    approveFirst({ decision: 'allow', source: 'human' });
    await assert.rejects(first, { code: 'delete_target_changed' });
    assert.equal(await readFile(target, 'utf8'), 'replacement during first approval');
  });
});

test('legacy trash backend configuration is refused with an actionable code', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'note.txt'), 'keep me');
    await assert.rejects(
      () => deleteTool.run({ path: 'note.txt' }, context(workspace, undefined, { trashBackend: 'shred' })),
      (error) => error.code === 'trash_legacy_config_unsupported',
    );
    assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'keep me');
  });
});

test('a platform without a backend resolves to no recycler and a stable code', async () => {
  assert.deepEqual(await resolveRecycler('darwin'), { recycler: undefined, code: 'recycle_backend_missing' });
});

test('the freedesktop backend prepares a newly selected trash root before sending a file', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'trash-'));
  const previous = process.env.XDG_DATA_HOME;
  try {
    process.env.XDG_DATA_HOME = join(root, 'previous-data');
    await freedesktopTrash.probe();
    process.env.XDG_DATA_HOME = join(root, 'data');
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'note.txt'), 'keep me');
    await freedesktopTrash.send(join(workspace, 'note.txt'));

    assert.equal(await readFile(join(root, 'data', 'Trash', 'files', 'note.txt'), 'utf8'), 'keep me');
    assert.match(await readFile(join(root, 'data', 'Trash', 'info', 'note.txt.trashinfo'), 'utf8'), /^\[Trash Info\]\n/);
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
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
    // 规范要的是本地时间：JS 把这一串按本地时间解析，所以下手时间与它相差不该超过一分钟。
    // 执行机正好在 UTC 时区时这条判不出时区差，形状那一条仍然在。
    const written = new Date(dateLine.slice('DeletionDate='.length));
    assert.ok(Math.abs(written.getTime() - Date.now()) < 60_000, `${dateLine} is not the local time of the deletion`);

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

// 回收站里可以躺着别的程序放的东西：没有信息文件的同名那一份也要让名字往后加计数，
// 反过来，移不进去时占名的信息文件要撤掉，别在回收站里留一个没有内容的条目。
test('the freedesktop backend skips a name another program took and leaves nothing after a failed move', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'trash-'));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(root, 'data');
  const infoDir = join(root, 'data', 'Trash', 'info');
  const files = join(root, 'data', 'Trash', 'files');
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await freedesktopTrash.probe();
    await writeFile(join(files, 'note.txt'), 'foreign');
    await writeFile(join(workspace, 'note.txt'), 'mine');
    await freedesktopTrash.send(join(workspace, 'note.txt'));
    assert.equal(await readFile(join(files, 'note.txt'), 'utf8'), 'foreign', 'what another program put there stays put');
    assert.equal(await readFile(join(files, 'note.txt.1'), 'utf8'), 'mine');
    assert.deepEqual(await readdir(infoDir), ['note.txt.1.trashinfo']);

    await assert.rejects(
      () => freedesktopTrash.send(join(workspace, 'gone.txt')),
      (error) => error.code === 'recycle_backend_failed',
    );
    assert.deepEqual(await readdir(infoDir), ['note.txt.1.trashinfo'], 'a move that failed leaves no info file behind');
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
  return { config: { boundary: workspace, limits }, logger: silentLogger, observations };
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
    const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }), permission: workspaceWrite });
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
