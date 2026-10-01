import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  createConfig, createDecisionChain, createKernel, createLoop, createSessionLog, findTool,
  loadAssembly, minimalPlugin, probeBackend, readTool,
} from '../src/index.js';

const sourceDirectory = fileURLToPath(new URL('../src/', import.meta.url));

function tool(name, run, execution) {
  return { name, description: `the ${name} tool`, parameters: { type: 'object', properties: {} }, execution, run };
}

test('清单第 1 条：全新构造的内核工具表为空，最小清单装载之后才有能力', () => {
  const kernel = createKernel();
  assert.deepEqual(kernel.list(), []);
  assert.deepEqual(kernel.manifest(), []);
  loadAssembly(kernel, [minimalPlugin]);
  assert.equal(kernel.list().length, 7);
});

test('清单第 2 条：装配清单能读出本次运行装了哪些插件', () => {
  const assembly = loadAssembly(createKernel(), [minimalPlugin, { name: 'extra', setup: () => () => {} }]);
  assert.deepEqual(assembly.list(), ['ligule-minimal', 'extra']);
});

test('清单第 3 条：两个插件声明同名工具时整份装载失败并回滚', () => {
  const kernel = createKernel();
  const asFirst = { name: 'a', setup: (host) => host.register(tool('dup', async () => ({}))) };
  const asSecond = { name: 'b', setup: (host) => host.register(tool('dup', async () => ({}))) };
  assert.throws(() => loadAssembly(kernel, [asFirst, asSecond]), (error) => error.code === 'tool_already_registered');
  assert.deepEqual(kernel.list(), []);
});

test('清单第 4 条：后一个守卫无法放宽前一个守卫的拒绝', async () => {
  const chain = createDecisionChain({ mode: 'auto', ask: async () => true });
  chain.guard(() => 'denied by the first guard');
  chain.guard(() => 'denied by the second guard');
  assert.deepEqual(await chain.evaluate({ tool: 'exec', input: { command: 'ls' } }), {
    decision: 'deny',
    code: 'guard_denied',
    reason: 'denied by the first guard',
  });
});

test('清单第 5 条：上级引用越界与链接指向边界之外，两种都拒绝', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'arch-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'ok.txt'), 'inside');
    await assert.rejects(
      () => readTool.run({ path: '../ok-outside.txt' }, { config: createConfig({ user: { boundary: workspace } }) }),
      (error) => error.code === 'path_escapes_boundary',
    );
    await mkdir(join(root, 'outside'), { recursive: true });
    await writeFile(join(root, 'outside', 'secret.txt'), 'outside');
    await symlink(join(root, 'outside'), join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      () => readTool.run({ path: 'link/secret.txt' }, { config: createConfig({ user: { boundary: workspace } }) }),
      (error) => error.code === 'path_escapes_through_link',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('清单第 6 条的工具部分：卸载插件后不留下工具', () => {
  const kernel = createKernel();
  const assembly = loadAssembly(kernel, [minimalPlugin]);
  assert.equal(kernel.manifest().length, 7);
  assembly.dispose();
  assert.deepEqual(kernel.manifest(), []);
  assert.deepEqual(kernel.list(), []);
});

test('清单第 7 条：上一轮模型看到的工具清单与注入内容能从会话记录重建', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'arch-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'note.txt'), 'the body');
    const session = createSessionLog({ directory: root, id: 'run' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }), session });
    const assembly = loadAssembly(kernel, [{ name: 'read-only', setup: (host) => {
      const disposers = [readTool, findTool].map((entry) => host.register(entry));
      return () => disposers.forEach((dispose) => dispose());
    } }]);
    const requests = [];
    const provider = {
      async *stream(request) {
        requests.push(request);
        yield* requests.length === 1
          ? [{ type: 'tool-call', id: 'call_1', name: 'read', args: { path: 'note.txt' } }]
          : [{ type: 'text', text: 'read it' }];
      },
    };
    assert.deepEqual((await createLoop({ kernel, provider, session }).run('read the note')).text, 'read it');
    assert.deepEqual(requests[0].tools.map((entry) => entry.name), ['find', 'read']);
    assert.deepEqual(requests[1].messages, [
      { role: 'user', text: 'read the note' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'read', args: { path: 'note.txt' } }] },
      { role: 'tool', id: 'call_1', tool: 'read', content: { text: 'the body' }, failed: false, code: undefined },
    ]);
    assembly.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('清单第 8 条：能力探测不出结果时报明确错误码，不静默降级', async () => {
  assert.deepEqual(await probeBackend({ name: 'no-probe' }), { name: 'no-probe', enforced: 'none', code: 'capability_probe_missing' });
  assert.deepEqual(await probeBackend({ name: 'broken', probe: () => { throw new Error('missing tool'); } }), {
    name: 'broken',
    enforced: 'none',
    code: 'capability_probe_failed',
  });
});

test('清单第 9 条：内核一侧不引入传输、界面与适配器，同进程直接调用跑通一轮', async () => {
  const kernelSide = ['kernel.js', 'config.js', 'log.js', 'error.js', 'policy.js', 'schema.js', 'session.js', 'assembly.js', 'prompt.js', 'loop.js', 'match.js', 'paths.js'];
  const forbidden = ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dns', 'node:worker_threads', 'cli.js', 'ui', 'dom'];
  for (const file of kernelSide) {
    const specifiers = [...readFileSync(join(sourceDirectory, file), 'utf8').matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.ok(!forbidden.some((entry) => specifier.includes(entry)), `${file} imports ${specifier}`);
    }
  }
  const kernel = createKernel();
  kernel.register(tool('ping', async () => ({ text: 'pong' })));
  let asked = 0;
  const provider = {
    async *stream() {
      asked += 1;
      yield* asked === 1 ? [{ type: 'tool-call', name: 'ping' }] : [{ type: 'text', text: 'done' }];
    },
  };
  assert.deepEqual(await createLoop({ kernel, provider }).run('go'), { text: 'done', iterations: 2, modelCalls: 2 });
});

test('清单第 11 条：参数模式形状不合法时注册当场失败', () => {
  const kernel = createKernel();
  assert.throws(
    () => kernel.register({ name: 'bad', description: 'd', parameters: { type: 'string' }, run: async () => ({}) }),
    (error) => error.code === 'tool_parameters_type_not_object',
  );
});
