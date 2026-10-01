import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createKernel, findTool, readOnlyTools, readTool, searchTool } from '../src/index.js';

const NEEDLE = 'needle here';

async function withWorkspace(run) {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'tools-'));
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'src'), { recursive: true });
  // node_modules 里放一条同样的命中，用来证明遍历确实跳过了它。
  await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(workspace, 'note.txt'), `line one\n${NEEDLE}\nline three`);
  await writeFile(join(workspace, 'src', 'app.js'), `const a = 'unused';\nsecond line ${NEEDLE}`);
  await writeFile(join(workspace, 'node_modules', 'pkg', 'index.js'), `${NEEDLE} but skipped`);
  try {
    return await run(workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function context(workspace, limits) {
  return { config: { boundary: workspace, limits } };
}

test('read returns the file content and says nothing about truncation when it fits', async () => {
  await withWorkspace(async (workspace) => {
    assert.deepEqual(await readTool.run({ path: 'note.txt' }, context(workspace)), {
      text: `line one\n${NEEDLE}\nline three`,
    });
  });
});

test('read cuts at the byte limit, leaves a visible marker, and the offset continues it', async () => {
  await withWorkspace(async (workspace) => {
    const first = await readTool.run({ path: 'note.txt' }, context(workspace, { readBytes: 10 }));
    assert.equal(first.text.slice(0, 10), 'line one\nn');
    assert.match(first.text, /\[truncated: 10 of 31 bytes shown, continue with offsetBytes=10]/);
    const rest = await readTool.run({ path: 'note.txt', offsetBytes: 10 }, context(workspace, { readBytes: 100 }));
    assert.equal(rest.text, `eedle here\nline three`);
  });
});

test('find returns sorted relative paths and honours the pattern kinds', async () => {
  await withWorkspace(async (workspace) => {
    assert.equal((await findTool.run({ pattern: '*.txt' }, context(workspace))).text, 'note.txt');
    assert.equal((await findTool.run({ pattern: '**/*.js' }, context(workspace))).text, 'src/app.js');
    assert.equal((await findTool.run({ pattern: '*.md' }, context(workspace))).text, '(no matches)');
  });
});

test('find stops at the result limit and says more matches follow', async () => {
  await withWorkspace(async (workspace) => {
    const result = await findTool.run({ pattern: '**' }, context(workspace, { resultCount: 1 }));
    assert.equal(result.text.split('\n')[0], 'note.txt');
    assert.match(result.text, /\[truncated: 1 matches shown and more follow, narrow the pattern]/);
  });
});

test('search reports file, line and text, and does not walk into node_modules', async () => {
  await withWorkspace(async (workspace) => {
    const result = await searchTool.run({ pattern: NEEDLE }, context(workspace));
    assert.deepEqual(result.text.split('\n'), [
      `note.txt:2:${NEEDLE}`,
      'src/app.js:2:second line needle here',
    ]);
  });
});

test('search narrows to one file when a path is given', async () => {
  await withWorkspace(async (workspace) => {
    assert.equal(
      (await searchTool.run({ pattern: NEEDLE, path: 'src/app.js' }, context(workspace))).text,
      `src/app.js:2:second line ${NEEDLE}`,
    );
  });
});

test('search walks a subdirectory when the path is one, and names files from the boundary', async () => {
  await withWorkspace(async (workspace) => {
    assert.equal(
      (await searchTool.run({ pattern: NEEDLE, path: 'src' }, context(workspace))).text,
      `src/app.js:2:second line ${NEEDLE}`,
    );
  });
});

test('find and search fail with a stable code when the path does not exist or is not a directory', async () => {
  await withWorkspace(async (workspace) => {
    await assert.rejects(findTool.run({ pattern: '*', path: 'missing' }, context(workspace)), { code: 'path_not_found' });
    await assert.rejects(searchTool.run({ pattern: NEEDLE, path: 'missing' }, context(workspace)), { code: 'path_not_found' });
    await assert.rejects(findTool.run({ pattern: '*', path: 'note.txt' }, context(workspace)), { code: 'find_path_not_directory' });
  });
});

test('the three read-only tools satisfy the registration contract and reach the manifest', async () => {
  const kernel = createKernel();
  for (const tool of readOnlyTools) kernel.register(tool);
  assert.deepEqual(kernel.list(), ['find', 'read', 'search']);
  assert.deepEqual(kernel.manifest().map((entry) => entry.name), ['find', 'read', 'search']);
  for (const entry of kernel.manifest()) {
    assert.deepEqual(Object.keys(entry).sort(), ['description', 'name', 'parameters']);
  }
});
