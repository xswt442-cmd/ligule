import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel, findTool, readOnlyTools, readTool, searchTool } from '../src/index.js';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
// npm run build-rg 生成的那一份 ripgrep。这个路径在 .gitignore 里，所以按真实后端做的比较
// 只在本地构建过之后才跑得起来；解析与排序的那些行为没法用假的可执行文件模拟。
const builtRipgrep = join(repo, 'packages', `rg-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'rg.exe' : 'rg');

const NEEDLE = 'needle here';

async function withWorkspace(run) {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'tools-'));
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'src'), { recursive: true });
  // node_modules 放两处：搜索根下一层与嵌套一层，两条后端都必须按任意深度跳过它。
  await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(join(workspace, 'src', 'node_modules', 'pkg'), { recursive: true });
  // 隐藏目录要搜得到：配置写在 .github/ 这类目录里，跳过整棵子树等于看不见。
  await mkdir(join(workspace, '.github', 'workflows'), { recursive: true });
  // 回收站那个目录反过来：删掉的东西不能再以第二次命中出现。
  await mkdir(join(workspace, '.ligule-trash'), { recursive: true });
  await writeFile(join(workspace, 'note.txt'), `line one\n${NEEDLE}\nline three`);
  await writeFile(join(workspace, 'src', 'app.js'), `const a = 'unused';\nsecond line ${NEEDLE}`);
  await writeFile(join(workspace, 'src', 'node_modules', 'pkg', 'deep.js'), `${NEEDLE} at depth`);
  await writeFile(join(workspace, 'node_modules', 'pkg', 'index.js'), `${NEEDLE} but skipped`);
  await writeFile(join(workspace, '.ligule-trash', 'gone.txt'), `${NEEDLE} already deleted`);
  await writeFile(join(workspace, '.github', 'workflows', 'ci.yml'), `name: ${NEEDLE}`);
  try {
    return await run(workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const silentLogger = { debug: () => {}, log: () => {} };

function context(workspace, limits, extra) {
  return { config: { boundary: workspace, limits, ...extra }, logger: silentLogger };
}

// 收集回落原因的日志接口：检索有两条后端，用不上外部那一条时要说清为什么。
function recordingContext(workspace, extra) {
  const logged = [];
  return {
    logged,
    context: {
      config: { boundary: workspace, ...extra },
      logger: { debug: (message, fields) => logged.push({ message, ...fields }), log: () => {} },
    },
  };
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
    assert.equal(result.text.split('\n')[0], '.github/workflows/ci.yml');
    assert.match(result.text, /\[truncated: 1 matches shown and more follow, narrow the pattern]/);
  });
});

test('search skips node_modules at any depth and the trash directory, but not hidden ones', async () => {
  await withWorkspace(async (workspace) => {
    const result = await searchTool.run({ pattern: NEEDLE }, context(workspace));
    assert.deepEqual(result.text.split('\n'), [
      '.github/workflows/ci.yml:1:name: needle here',
      'note.txt:2:needle here',
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

test('search walks the tree itself when no external backend is there, and says why', async () => {
  await withWorkspace(async (workspace) => {
    const { logged, context: searchContext } = recordingContext(workspace);
    const result = await searchTool.run({ pattern: NEEDLE }, searchContext);
    assert.deepEqual(result.text.split('\n'), [
      '.github/workflows/ci.yml:1:name: needle here',
      'note.txt:2:needle here',
      'src/app.js:2:second line needle here',
    ]);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].code, 'search_backend_missing');
  });
});

test('search with no hit says so instead of returning empty text', async () => {
  await withWorkspace(async (workspace) => {
    assert.equal((await searchTool.run({ pattern: 'absent string' }, context(workspace))).text, '(no matches)');
  });
});

test('search of an explicit file inside a skipped directory still reads that file', async () => {
  await withWorkspace(async (workspace) => {
    assert.equal(
      (await searchTool.run({ pattern: NEEDLE, path: '.ligule-trash/gone.txt' }, context(workspace))).text,
      '.ligule-trash/gone.txt:1:needle here already deleted',
    );
  });
});

// 换后端不换行为（D18）：命中行与顺序都要相同。这里没有二进制文件，所以两边连最后一行的
// 跳过标记都不该出现——那条标记只属于自己遍历那一条，它知道自己跳过了什么，外部后端不交这个数。
test('the external backend and our own walk return the same hits in the same order', async (t) => {
  if (!existsSync(builtRipgrep)) return t.skip('no ripgrep built locally, run npm run build-rg');
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'crlf.txt'), `windows line endings ${NEEDLE}\r\ntail`);
    const both = async (args) => [
      (await searchTool.run(args, context(workspace, undefined, { ripgrepPath: builtRipgrep }))).text,
      (await searchTool.run(args, context(workspace))).text,
    ];
    const [external, own] = await both({ pattern: NEEDLE });
    assert.equal(external, own);
    assert.deepEqual(external.split('\n'), [
      '.github/workflows/ci.yml:1:name: needle here',
      'crlf.txt:1:windows line endings needle here',
      'note.txt:2:needle here',
      'src/app.js:2:second line needle here',
    ]);
    // 点名到回收站里的一个文件：那种路径外部后端不套排除项，两边都得搜到。
    const [fromTrash, walkedFromTrash] = await both({ pattern: NEEDLE, path: '.ligule-trash/gone.txt' });
    assert.equal(fromTrash, walkedFromTrash);
    assert.match(fromTrash, /gone\.txt:1:/);
  });
});

test('the external backend gives the same text twice over', async (t) => {
  if (!existsSync(builtRipgrep)) return t.skip('no ripgrep built locally, run npm run build-rg');
  await withWorkspace(async (workspace) => {
    const run = async () => (await searchTool.run({ pattern: NEEDLE }, context(workspace, undefined, { ripgrepPath: builtRipgrep }))).text;
    assert.equal(await run(), await run());
  });
});

// 检索的子进程要在边界里跑，配置里那个相对路径不能跟着子进程的当前目录走（本机实测：跟着走就是 ENOENT）。
test('a relative ripgrepPath is read against the process directory, not the boundary', async (t) => {
  if (!existsSync(builtRipgrep)) return t.skip('no ripgrep built locally, run npm run build-rg');
  await withWorkspace(async (workspace) => {
    const { logged, context: searchContext } = recordingContext(workspace, { ripgrepPath: relative(process.cwd(), builtRipgrep) });
    const result = await searchTool.run({ pattern: NEEDLE }, searchContext);
    assert.deepEqual(logged, []);
    assert.match(result.text, /note\.txt:2:/);
  });
});

test('a configured ripgrep that cannot run is reported and search still returns hits', async () => {
  await withWorkspace(async (workspace) => {
    const { logged, context: searchContext } = recordingContext(workspace, { ripgrepPath: join(workspace, 'no-such-rg') });
    const result = await searchTool.run({ pattern: NEEDLE }, searchContext);
    assert.match(result.text, /note\.txt:2:needle here/);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].code, 'search_backend_failed');
    assert.ok(logged[0].detail !== undefined);
  });
});

test('a cancelled search and find report their own code on the walk backend', async () => {
  await withWorkspace(async (workspace) => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = { config: { boundary: workspace }, logger: silentLogger, signal: controller.signal };
    await assert.rejects(searchTool.run({ pattern: NEEDLE }, cancelled), { code: 'search_cancelled' });
    await assert.rejects(findTool.run({ pattern: '**' }, cancelled), { code: 'find_cancelled' });
  });
});

// 取消落在遍历中途：abort 在第一个 await 之前发生，所以这条不靠时序运气。
test('a search cancelled while it is walking stops walking', async () => {
  await withWorkspace(async (workspace) => {
    const controller = new AbortController();
    const running = searchTool.run({ pattern: NEEDLE }, { config: { boundary: workspace }, logger: silentLogger, signal: controller.signal });
    controller.abort();
    await assert.rejects(running, { code: 'search_cancelled' });
  });
});

test('a pre-cancelled call never starts the external backend', async (t) => {
  if (!existsSync(builtRipgrep)) return t.skip('no ripgrep built locally, run npm run build-rg');
  await withWorkspace(async (workspace) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      searchTool.run({ pattern: NEEDLE }, { config: { boundary: workspace, ripgrepPath: builtRipgrep }, logger: silentLogger, signal: controller.signal }),
      { code: 'search_cancelled' },
    );
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
