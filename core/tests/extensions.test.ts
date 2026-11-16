// 验证扩展的查找位置、可用接口，以及加载失败时的行为。
// 临时目录里的模块是真的 ESM 文件，用真的动态 import 跑；内核、判定链、提示词组装也都是真的。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  createConfig, createKernel, createPermissionContext, createSessionLog, extensionSources, loadAssembly, loadExtensions, minimalPlugin,
} from '../dist/index.js';
import { prepareExtensionRequest } from '../dist/kernel/extensions.js';
import type { ToolDefinition } from '../dist/kernel/kernel.js';
import type { Connection } from '../dist/host/connection.js';
import type { Host } from '../dist/host/host.js';
import type { ModelRequest } from '../dist/kernel/loop.js';
import type { PolicyMode } from '../dist/kernel/policy.js';
import { testHostProvider } from './helpers/provider.ts';
import { waitFor, withTuiHost } from './helpers/tui-host.ts';

type ExtensionFragment = { name: string; text: string; source: string };
type ExtensionLoadOptions = Parameters<typeof loadExtensions>[1] & { config?: Record<string, never> };

const shippedModes = fileURLToPath(new URL('../modes/', import.meta.url));
const projectContextExtension = fileURLToPath(new URL('../examples/extensions/project-context.mjs', import.meta.url));
const projectAuditExtension = fileURLToPath(new URL('../examples/extensions/project-audit.mjs', import.meta.url));
const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

// 每一条测试都要一份真的临时目录（扩展文件是被真动态 import 的），跑完一起收掉。
const created: string[] = [];
async function directoryWith(files: Record<string, string>): Promise<string> {
  const temporaryRoot = join(process.cwd(), 'testplace', 'tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(join(temporaryRoot, 'ligule-extensions-'));
  created.push(root);
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  return root;
}
after(() => Promise.all(created.map((root) => rm(root, { recursive: true, force: true }))));

test('sources come from the install directory, the user layer and the command line, not from the repository', async () => {
  const root = await directoryWith({ 'b.js': '', 'a.js': '', 'notes.txt': '' });
  const installedDirectory = join(root, '.ligule', 'extensions');
  const readDirectory = (path: string) => (path === installedDirectory
    ? Promise.resolve(['b.js', 'a.js', 'notes.txt'])
    : Promise.reject(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })));
  const listed = await extensionSources(
    {
      user: { extensions: ['tools/deep.js'] },
      flag: { extensions: [] },
      project: { extensions: ['evil.js'] },
      local: { extensions: ['also-evil.js'] },
    },
    { projectRoot: root, userHome: root, readDirectory },
  );
  assert.deepEqual(listed.paths, [join(installedDirectory, 'a.js'), join(installedDirectory, 'b.js'), join(root, 'tools', 'deep.js')].sort());
  assert.equal(listed.installedDirectory, installedDirectory);
  assert.deepEqual(listed.ignored.map((entry) => [entry.code, entry.path]), [['extension_source_ignored', 'project'], ['extension_source_ignored', 'local']]);
  assert.deepEqual(Object.values(listed.installNames).sort(), ['a', 'b']);
  assert.deepEqual(listed.disabled, []);
  // 安装目录不存在不是错误：一行都没装过是正常状态。
  const missing = await extensionSources({}, { projectRoot: root, userHome: join(root, 'nope'), readDirectory: () => Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' })) });
  assert.deepEqual(missing.paths, []);
});

test('directory packages load through index.js and the disable registry filters installed entries only', async () => {
  const root = await directoryWith({});
  const installedDirectory = join(root, '.ligule', 'extensions');
  const readDirectory = (path: string) => {
    if (path === installedDirectory) return Promise.resolve(['solo.js', 'pack', 'half-pack', 'state.json']);
    if (path === join(installedDirectory, 'pack')) return Promise.resolve(['index.js', 'notes.md']);
    if (path === join(installedDirectory, 'half-pack')) return Promise.resolve([' readme.md ']);
    return Promise.reject(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }));
  };
  const listed = await extensionSources({}, { projectRoot: root, userHome: root, readDirectory, disabled: ['pack'] });
  assert.deepEqual(listed.paths, [join(installedDirectory, 'solo.js')], '停用的目录包不加载，缺 index.js 的目录也不加载');
  assert.deepEqual(listed.disabled, [{ name: 'pack', path: join(installedDirectory, 'pack', 'index.js') }]);
  assert.deepEqual(listed.installNames[join(installedDirectory, 'pack', 'index.js')], 'pack');
  assert.ok(listed.ignored.some((entry) => entry.code === 'extension_package_index_missing' && entry.path.endsWith('half-pack')), '缺入口的目录包给出诊断');
  // 配置层显式声明的路径不受启停登记约束。
  const declared = await extensionSources(
    { user: { extensions: [join(installedDirectory, 'pack', 'index.js')] } },
    { projectRoot: root, userHome: root, readDirectory, disabled: ['pack'] },
  );
  assert.deepEqual(declared.paths, [join(installedDirectory, 'solo.js'), join(installedDirectory, 'pack', 'index.js')]);
});

test('the extension state registry round-trips and treats unreadable documents as empty', async () => {
  const root = await directoryWith({});
  const { extensionStatePath, readExtensionState, writeExtensionState } = await import('../dist/kernel/extension-state.js');
  const statePath = extensionStatePath(root);
  assert.deepEqual(await readExtensionState(root), { disabled: [] }, '没有登记文件时为空');
  await writeExtensionState(root, ['pack', 'pack', 'solo']);
  assert.deepEqual(await readExtensionState(root), { disabled: ['pack', 'solo'] }, '写入去重并排序');
  await writeFile(statePath, '{', 'utf8');
  const broken = await readExtensionState(root);
  assert.deepEqual(broken.disabled, [], '损坏按空登记处理');
  assert.ok(broken.invalid, '损坏原因可见');
  // 停用名单不可信：unavailable 让环境装载把全部已安装扩展退出活动路径，
  // extensions.set 中止写入而不是以空名单覆盖。
  assert.ok(broken.unavailable, '损坏时名单不可信');
  const installedDirectory = join(root, '.ligule', 'extensions');
  const readDirectory = (path: string) => (path === installedDirectory
    ? Promise.resolve(['pack.js'])
    : Promise.reject(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })));
  const blocked = await extensionSources({}, { projectRoot: root, userHome: root, readDirectory, disabled: null });
  assert.deepEqual(blocked.paths, [], '登记不可读时安装扩展不进活动路径');
  assert.deepEqual(blocked.disabled, [{ name: 'pack', path: join(installedDirectory, 'pack.js') }], '全部按停用展示');
  // 配置层显式声明的路径不受登记影响。
  const declared = await extensionSources(
    { user: { extensions: [join(installedDirectory, 'pack.js')] } },
    { projectRoot: root, userHome: root, readDirectory, disabled: null },
  );
  assert.deepEqual(declared.paths, [join(installedDirectory, 'pack.js')]);
});

test('the narrow interface contains only declared capabilities and registrations reach their owners', async () => {
  const root = await directoryWith({
    'one.js': `export default function one(host) {
  host.registerTool({ name: 'extra', description: 'from the extension', access: 'read', parameters: { type: 'object', properties: {} }, run: async () => ({ text: 'ran' }) });
  host.registerPrompt({ name: 'notes', text: 'what the extension wants said' });
  globalThis.__seen = Object.keys(host).sort().join(',');
}`,
  });
  const kernel = createKernel({ config: createConfig({ user: { boundary: root } }) });
  const fragments: ExtensionFragment[] = [];
  const options: ExtensionLoadOptions = {
    config: {},
    registerTool: (tool) => kernel.register(tool as ToolDefinition),
    registerFragment: (fragment) => {
      fragments.push(fragment);
      return () => fragments.splice(fragments.indexOf(fragment), 1);
    },
    addEventListener: () => () => {},
    request: (name, args) => kernel.call(name, args),
  };
  const loaded = await loadExtensions([join(root, 'one.js')], options);
  assert.deepEqual(loaded.loaded.map((entry) => entry.name), ['one']);
  assert.equal((globalThis as { __seen?: string }).__seen, 'onEvent,registerHook,registerPrompt,registerTool,request');
  assert.deepEqual(kernel.list(), ['extra']);
  assert.equal(fragments[0].text, 'what the extension wants said');
  await loaded.dispose();
  assert.deepEqual(kernel.list(), []);
  assert.deepEqual(fragments, []);
});

test('extension setup can register an owned lifecycle hook', async () => {
  const root = await directoryWith({
    'hook.js': `export default function hook(host) {
  globalThis.__p11HookRegistration = typeof host.registerHook;
  globalThis.__p11RegisterHook = host.registerHook;
  globalThis.__p11RemoveHook = host.registerHook({ phase: 'prepareRequest', name: 'project-notes', run: () => ({ context: [] }) });
}`,
  });
  const kernel = createKernel({ config: createConfig({ user: { boundary: root } }) });
  const options: ExtensionLoadOptions = {
    config: {},
    registerTool: (tool) => kernel.register(tool as ToolDefinition),
    registerFragment: () => () => {},
    addEventListener: () => () => {},
    request: (name, args) => kernel.call(name, args),
  };
  try {
    const loaded = await loadExtensions([join(root, 'hook.js')], options);
    assert.deepEqual(loaded.diagnostics, []);
    assert.equal((globalThis as { __p11HookRegistration?: string }).__p11HookRegistration, 'function');
    const [registration] = loaded.hooks.forPhase('prepareRequest');
    assert.equal(registration?.extension, 'hook');
    assert.equal(registration?.hook.name, 'project-notes');
    (globalThis as { __p11RemoveHook?: () => void }).__p11RemoveHook?.();
    assert.deepEqual(loaded.hooks.forPhase('prepareRequest'), []);
    await loaded.dispose();
    assert.throws(() => (globalThis as { __p11RegisterHook?: (hook: unknown) => void }).__p11RegisterHook?.({
      phase: 'prepareRequest', name: 'late', run: () => undefined,
    }), { code: 'extension_inactive' });
  } finally {
    delete (globalThis as { __p11HookRegistration?: string }).__p11HookRegistration;
    delete (globalThis as { __p11RegisterHook?: (hook: unknown) => void }).__p11RegisterHook;
    delete (globalThis as { __p11RemoveHook?: () => void }).__p11RemoveHook;
  }
});

test('duplicate Hook names fail only the conflicting extension and roll back its partial registrations', async () => {
  const root = await directoryWith({
    'first.js': `export default function first(host) {
  host.registerHook({ phase: 'beforeTool', name: 'limit', run: () => ({ decision: 'continue' }) });
}`,
    'duplicate.js': `export default function duplicate(host) {
  host.registerPrompt({ name: 'partial', text: 'must be removed' });
  host.registerHook({ phase: 'beforeTool', name: 'limit', run: () => ({ decision: 'continue' }) });
}`,
  });
  const kernel = createKernel({ config: createConfig({ user: { boundary: root } }) });
  const fragments: ExtensionFragment[] = [];
  const loaded = await loadExtensions([join(root, 'first.js'), join(root, 'duplicate.js')], {
    registerTool: (tool) => kernel.register(tool as ToolDefinition),
    registerFragment: (fragment) => { fragments.push(fragment); return () => { const index = fragments.indexOf(fragment); if (index >= 0) fragments.splice(index, 1); }; },
    addEventListener: () => () => {},
    request: (name, args) => kernel.call(name, args),
  });
  assert.deepEqual(loaded.loaded.map((extension) => extension.name), ['first']);
  assert.deepEqual(loaded.diagnostics.map((item) => item.code), ['extension_hook_duplicate']);
  const hooks = loaded.hooks.forPhase('beforeTool');
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].extension, 'first');
  assert.equal(fragments.length, 0, 'the conflicting extension loses its partial Prompt registration');
  await loaded.dispose();
  assert.deepEqual(loaded.hooks.forPhase('beforeTool'), []);
});

test('a broken extension takes back its own registrations and leaves the others alone', async () => {
  const root = await directoryWith({
    'good.js': 'export default function good(host) { host.registerTool({ name: "keep", description: "stays", access: "read", parameters: { type: "object", properties: {} }, run: async () => ({ text: "ok" }) }); }',
    'no-default.js': 'export const notAFactory = 1;',
    'throws.js': 'export default function throws(host) { host.registerTool({ name: "half", description: "must not stay", access: "read", parameters: { type: "object", properties: {} }, run: async () => ({ text: "ok" }) }); throw new Error("boom in setup"); }',
  });
  const kernel = createKernel({ config: createConfig({ user: { boundary: root } }) });
  const options: ExtensionLoadOptions = {
    config: {},
    registerTool: (tool) => kernel.register(tool as ToolDefinition),
    registerFragment: () => () => {},
    addEventListener: () => () => {},
    request: (name, args) => kernel.call(name, args),
  };
  const loaded = await loadExtensions(
    [join(root, 'good.js'), join(root, 'no-default.js'), join(root, 'throws.js')],
    options,
  );
  assert.deepEqual(loaded.diagnostics.map((entry) => entry.code), ['extension_shape_invalid', 'extension_load_failed']);
  assert.match(loaded.diagnostics[1].detail, /boom in setup/);
  // 坏掉那件自己登记的半截被撤走，前一件好的留下：一次装载失败不留半装的表，也不带走别人。
  assert.deepEqual(kernel.list(), ['keep']);
});

test('extension disposal attempts all owned cleanups in reverse order and only once', async () => {
  const root = await directoryWith({
    'cleanup.js': `export default function cleanup(host) {
  host.registerTool({ name: 'cleanup-tool', description: 'tool', access: 'read', parameters: { type: 'object', properties: {} }, run: async () => ({ text: 'ok' }) });
  host.registerPrompt({ name: 'cleanup-prompt', text: 'prompt' });
  host.onEvent(() => {});
  return () => { throw new Error('extension disposer failed'); };
}`,
  });
  const kernel = createKernel({ config: createConfig({ user: { boundary: root } }) });
  const fragments = new Map<string, ExtensionFragment>();
  const listeners = new Set<(event: unknown) => void>();
  const loaded = await loadExtensions([join(root, 'cleanup.js')], {
    registerTool: (tool) => kernel.register(tool as ToolDefinition),
    registerFragment: (fragment) => { fragments.set(fragment.name, fragment); return () => fragments.delete(fragment.name); },
    addEventListener: (handler) => { listeners.add(handler); return () => listeners.delete(handler); },
    request: (name, args) => kernel.call(name, args),
  });
  await assert.rejects(loaded.dispose(), (error) => error instanceof Error && error.message === 'extension disposer failed');
  assert.deepEqual(kernel.list(), []);
  assert.equal(fragments.size, 0);
  assert.equal(listeners.size, 0);
  await loaded.dispose();
  assert.deepEqual(kernel.list(), []);
});

test('extension disposal awaits async disposers and completes exactly once', async () => {
  const root = await directoryWith({
    'async-cleanup.js': `export default function asyncCleanup() {
  return async () => {
    globalThis.__p11DisposerCalls = (globalThis.__p11DisposerCalls || 0) + 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    globalThis.__p11DisposerFinished = true;
  };
}`,
  });
  const loaded = await loadExtensions([join(root, 'async-cleanup.js')], {
    registerTool: () => () => {},
    registerFragment: () => () => {},
    addEventListener: () => () => {},
    request: async () => undefined,
  });
  try {
    const pending = loaded.dispose();
    assert.equal((globalThis as { __p11DisposerFinished?: boolean }).__p11DisposerFinished, undefined);
    await pending;
    assert.equal((globalThis as { __p11DisposerFinished?: boolean }).__p11DisposerFinished, true);
    assert.equal((globalThis as { __p11DisposerCalls?: number }).__p11DisposerCalls, 1);
    await loaded.dispose();
    assert.equal((globalThis as { __p11DisposerCalls?: number }).__p11DisposerCalls, 1);
  } finally {
    delete (globalThis as { __p11DisposerCalls?: number }).__p11DisposerCalls;
    delete (globalThis as { __p11DisposerFinished?: boolean }).__p11DisposerFinished;
  }
});

test('extension setup failure keeps its error visible when owned cleanup also fails', async () => {
  const root = await directoryWith({
    'broken-cleanup.js': `export default function brokenCleanup(host) {
  host.registerTool({ name: 'partial-tool', description: 'tool', access: 'read', parameters: { type: 'object', properties: {} }, run: async () => ({ text: 'ok' }) });
  host.registerPrompt({ name: 'partial-prompt', text: 'prompt' });
  throw new Error('original setup failure');
}`,
  });
  const kernel = createKernel({ config: createConfig({ user: { boundary: root } }) });
  const fragments = new Map<string, ExtensionFragment>();
  const loaded = await loadExtensions([join(root, 'broken-cleanup.js')], {
    registerTool: (tool) => kernel.register(tool as ToolDefinition),
    registerFragment: (fragment) => { fragments.set(fragment.name, fragment); return () => { fragments.delete(fragment.name); throw new Error('fragment cleanup failed'); }; },
    addEventListener: () => () => {},
    request: (name, args) => kernel.call(name, args),
  });
  assert.equal(loaded.diagnostics.length, 1);
  assert.match(loaded.diagnostics[0].detail, /original setup failure/);
  assert.match(loaded.diagnostics[0].detail, /fragment cleanup failed/);
  assert.deepEqual(kernel.list(), []);
  assert.equal(fragments.size, 0);
});

test('extension requests still pass through Kernel and are unavailable after extension disposal', async () => {
  const root = await directoryWith({
    'calls.js': `export default function calls(host) {
  globalThis.__request = () => host.request('read', { path: '../outside.txt' });
}`,
  });
  const kernel = createKernel({ config: createConfig({ user: { boundary: root } }) });
  loadAssembly(kernel, [minimalPlugin]);
  const options: ExtensionLoadOptions = {
    config: {},
    registerTool: (tool) => kernel.register(tool as ToolDefinition),
    registerFragment: () => () => {},
    addEventListener: () => () => {},
    request: (name, args) => kernel.call(name, args),
  };
  const loaded = await loadExtensions([join(root, 'calls.js')], options);
  await assert.rejects(
    () => (globalThis as unknown as { __request: () => Promise<unknown> }).__request(),
    (error) => error instanceof Error && (error as { code?: string }).code === 'path_escapes_boundary',
    'the boundary is not something an extension can step around by asking',
  );
  await loaded.dispose();
  await assert.rejects(
    () => (globalThis as unknown as { __request: () => Promise<unknown> }).__request(),
    { code: 'extension_inactive' },
  );
  delete (globalThis as unknown as { __request?: () => Promise<unknown> }).__request;
});

// 判据那一条：一份扩展装上一件工具与一段提示词片段，选它的模式看得见这两样；名字写错在装载那一刻就报。
const { createConnection, createMemoryConnectionPair, MESSAGES_CAPABILITIES, modeDirectories, serveHost } = await import('../dist/index.js');

async function withSession<TResult>(
  modePrompt: readonly string[],
  run: (connection: Connection, requests: ModelRequest[], host: Host) => TResult | Promise<TResult>,
): Promise<TResult> {
  const root = await directoryWith({
    'one.js': 'export default function one(host) { host.registerTool({ name: "extra", description: "from the extension", access: "read", parameters: { type: "object", properties: {} }, run: async () => ({ text: "ran" }) }); host.registerPrompt({ name: "notes", text: "what the extension wants said" }); }',
  });
  const userHome = join(root, 'home');
  const directories = modeDirectories(root, shippedModes, userHome);
  await mkdir(directories.user, { recursive: true });
  await writeFile(join(directories.user, 'picked.toml'), `tools = "*"\nprompt = ${JSON.stringify(modePrompt)}\n`);
  const config = createConfig({ user: { boundary: root, model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'm' }, policy: { mode: 'ask' } } });
  const requests: ModelRequest[] = [];
  const provider = testHostProvider({
    capabilities: MESSAGES_CAPABILITIES,
    model: 'm',
    async *stream(request: ModelRequest) {
      requests.push(request);
      yield { type: 'text', text: 'ok' };
    },
  });
  const pair = createMemoryConnectionPair();
  const host = serveHost({
    input: pair.host.input,
    output: pair.host.output,
    config,
    provider,
    policy: config.policy as { mode?: PolicyMode },
    permission: fullAccess,
    modeName: 'picked',
    modePaths: directories,
    extensions: { paths: [join(root, 'one.js')], ignored: [] },
  });
  const connection = createConnection(pair.client);
  try {
    return await run(connection, requests, host);
  } finally {
    pair.client.output.end();
    await host.release();
  }
}

test('a mode that picks an extension fragment hands the tool and the text to the model', async () => {
  await withSession(['notes'], async (connection, requests) => {
    const { sessionId } = await connection.request('session.create', {}) as { sessionId: string };
    await connection.request('run.start', { sessionId, input: 'say ok' });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].tools.map((entry) => entry.name).includes('extra'), 'the extension tool reaches the manifest');
    assert.match(JSON.stringify(requests[0].system ?? requests[0]), /what the extension wants said/);
  });
});

test('a mode naming a fragment nobody registered fails at the request, not silently', async () => {
  const failure = await withSession(['absent'], (connection) =>
    connection.request('session.create', {}).catch((error: unknown) => error)) as { code: string; detail: string };
  assert.equal(failure.code, 'mode_prompt_unavailable');
  assert.match(failure.detail, /absent/);
});

test('P10 nested extension request inherits cancellation from its active Host Run', { timeout: 20_000 }, async () => {
  const root = await directoryWith({
    'nested-extension.mjs': `import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      export default function nested(host) {
      host.registerTool({
        name: 'extension_nested_exec',
        description: 'Run the nested cancellation fixture.',
        access: 'read',
        parameters: { type: 'object', properties: { directory: { type: 'string' } }, required: ['directory'] },
        run: async ({ directory }, context) => {
          writeFileSync(join(directory, 'nested-parent-signal.txt'), context.signal === undefined ? 'missing' : 'present');
          context.signal?.addEventListener('abort', () => writeFileSync(join(directory, 'nested-parent-aborted.txt'), 'aborted'), { once: true });
          return await host.request('exec', { command: 'node nested-child.mjs' });
        },
      });
    }`,
  });
  try {
    await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
      const startedPath = join(projectDirectory, 'nested-started.txt');
      const parentSignalPath = join(projectDirectory, 'nested-parent-signal.txt');
      const parentAbortedPath = join(projectDirectory, 'nested-parent-aborted.txt');
      const completedPath = join(projectDirectory, 'nested-completed.txt');
      await client.request('workspace.trust', {
        projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
      });
      client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
      const running = client.request('run.start', {
        sessionId,
        input: JSON.stringify({ tool: 'extension_nested_exec', args: { directory: projectDirectory } }),
      }).then(() => undefined, (error: unknown) => error);

      await waitFor(() => existsSync(startedPath), { within: 5_000, every: 20 });
      await waitFor(() => existsSync(parentSignalPath), { within: 1_000, every: 20 });
      const parentSignal = await readFile(parentSignalPath, 'utf8');
      const before = await client.request('status.get', { sessionId }) as {
        task?: { modelCalls: number; executionElapsedMs: number; executionPaused: boolean } | null;
      };
      assert.ok(before.task);
      await delay(350);
      const during = await client.request('status.get', { sessionId }) as {
        task?: { modelCalls: number; executionElapsedMs: number; executionPaused: boolean } | null;
      };
      assert.ok(during.task);
      assert.equal(during.task.modelCalls, before.task.modelCalls, 'the delayed nested tool does not start another model request');
      assert.equal(during.task.executionPaused, false, 'nested tool work remains active, not paused');
      assert.ok(during.task.executionElapsedMs - before.task.executionElapsedMs >= 250,
        'the shared Run budget continues to count nested tool work');
      assert.deepEqual(await client.request('run.cancel', { sessionId }), { cancelled: true });
      await waitFor(() => existsSync(parentAbortedPath), { within: 1_000, every: 20 });
      await running;
      await delay(2_200);

      assert.equal(parentSignal, 'present', 'Host must pass the active Run signal to the outer extension tool');
      assert.equal(await readFile(parentAbortedPath, 'utf8'), 'aborted', 'run.cancel must abort the active extension tool');
      assert.equal(existsSync(completedPath), false,
        `the nested exec process must stop with its parent Run (parentSignal=${parentSignal})`);
      const record = await client.request('session.read', { sessionId }) as { events: {
        kind?: string; tool?: string; callId?: string; parentCallId?: string; run?: { runId?: string }; runId?: string;
      }[] };
      const outer = record.events.find((event) => event.kind === 'tool' && event.tool === 'extension_nested_exec');
      const nested = record.events.find((event) => event.kind === 'tool' && event.tool === 'exec');
      const runId = record.events.find((event) => event.kind === 'user')?.run?.runId;
      assert.ok(outer?.callId);
      assert.ok(nested?.callId);
      assert.equal(nested.parentCallId, outer.callId);
      assert.equal(nested.runId, runId);
    }, {
      extensions: { paths: [join(root, 'nested-extension.mjs')], ignored: [] },
      permission: fullAccess,
      interactive: true,
      permissionControl: true,
      modeName: 'p10-nested',
      setup: async ({ projectDirectory, homeDirectory }) => {
        await writeFile(join(projectDirectory, 'nested-child.mjs'), [
          "import { writeFileSync } from 'node:fs';",
          "writeFileSync('nested-started.txt', 'started');",
          'await new Promise((resolve) => setTimeout(resolve, 1600));',
          "writeFileSync('nested-completed.txt', 'completed');",
        ].join('\n'));
        const directories = modeDirectories(projectDirectory, shippedModes, homeDirectory);
        await mkdir(directories.user, { recursive: true });
        await writeFile(join(directories.user, 'p10-nested.toml'), 'tools = "*"\nprompt = []\n');
      },
      testDirectory: 'testplace/tmp',
      config: { limits: { execTimeoutMs: 8_000 } },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P10 an extension event cannot start a tool call without an active execution context', { timeout: 15_000 }, async () => {
  const root = await directoryWith({});
  const resultPath = join(root, 'extension-request-result.txt');
  const extensionPath = join(root, 'outside-run.mjs');
  await writeFile(extensionPath, `import { writeFileSync } from 'node:fs';
    export default function outsideRun(host) {
      host.registerTool({
        name: 'extension_event_probe',
        description: 'Complete the local event-context fixture.',
        access: 'read',
        parameters: { type: 'object', properties: {} },
        run: async () => ({ text: 'done' }),
      });
      host.onEvent((event) => {
        if (event.kind !== 'tool' || event.tool !== 'extension_event_probe') return;
        void host.request('exec', { command: 'node nested-child.mjs' }).then(
          () => writeFileSync(${JSON.stringify(resultPath)}, 'completed'),
          (error) => writeFileSync(${JSON.stringify(resultPath)}, String(error?.code ?? 'failed')),
        );
      });
    }`);
  try {
    await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
      await writeFile(join(projectDirectory, 'nested-child.mjs'), [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync('outside-child-started.txt', 'started');",
      ].join('\n'));
      await client.request('workspace.trust', {
        projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
      });
      client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
      await client.request('run.start', {
        sessionId, input: JSON.stringify({ tool: 'extension_event_probe', args: {} }),
      });
      await waitFor(() => existsSync(resultPath), { within: 2_000, every: 20 });

      assert.equal(await readFile(resultPath, 'utf8'), 'extension_request_context_unavailable');
      assert.equal(existsSync(join(projectDirectory, 'outside-child-started.txt')), false,
        'an event listener must not start a command under the Run that happens to be active');
    }, {
      extensions: { paths: [extensionPath], ignored: [] },
      permission: fullAccess,
      interactive: true,
      permissionControl: true,
      modeName: 'p10-event',
      setup: async ({ projectDirectory, homeDirectory }) => {
        const directories = modeDirectories(projectDirectory, shippedModes, homeDirectory);
        await mkdir(directories.user, { recursive: true });
        await writeFile(join(directories.user, 'p10-event.toml'), 'tools = "*"\nprompt = []\n');
      },
      testDirectory: 'testplace/tmp',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Host Session close awaits an extension async disposer', { timeout: 10_000 }, async () => {
  const root = await directoryWith({});
  const startedPath = join(root, 'disposer-started.txt');
  const finishedPath = join(root, 'disposer-finished.txt');
  const extensionPath = join(root, 'async-disposer.mjs');
  await writeFile(extensionPath, `import { writeFileSync } from 'node:fs';
export default function asyncDisposer() {
  return async () => {
    writeFileSync(${JSON.stringify(startedPath)}, 'started');
    await new Promise((resolve) => setTimeout(resolve, 40));
    writeFileSync(${JSON.stringify(finishedPath)}, 'finished');
  };
}`);

  try {
    await withTuiHost(async ({ client, sessionId }) => {
      await client.request('session.close', { sessionId });
      assert.equal(await readFile(startedPath, 'utf8'), 'started');
      assert.equal(await readFile(finishedPath, 'utf8'), 'finished', 'Host close returns only after the async disposer settles');
    }, {
      extensions: { paths: [extensionPath], ignored: [] },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      testDirectory: 'testplace/tmp',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('request preparation Hooks receive the active Run and affect the actual Provider request', { timeout: 15_000 }, async () => {
  const root = await directoryWith({
    'request-context.mjs': `export default function requestContext(host) {
  host.registerHook({
    phase: 'prepareRequest',
    name: 'project-notes',
    run: async (context) => {
      const read = await context.request('read', { path: 'note.txt' });
      let deniedWrite = '';
      try { await context.request('create', { path: 'hook-write.txt', content: 'must stay absent' }); }
      catch (error) { deniedWrite = error.code; }
      const firstUser = context.messages.find((message) => message.role === 'user');
      try { firstUser.text = 'mutated by extension'; } catch {}
      globalThis.__p11RequestHookContext = {
        extension: context.extension,
        hook: context.hook,
        sessionId: context.sessionId,
        runId: context.runId,
        source: context.source,
        attempt: context.attempt,
        hasUserMessage: context.messages.some((message) => message.role === 'user' && message.text === 'read request context'),
        firstUserText: firstUser.text,
        deniedWrite,
      };
      return { context: 'Project notes: ' + read.text };
    },
  });
}`,
  });
  const extensionPath = join(root, 'request-context.mjs');
  try {
    await withTuiHost(async ({ client, sessionId, providerRequests, projectDirectory }) => {
      await client.request('run.start', { sessionId, input: 'read request context' });
      assert.equal(providerRequests.length, 1);
      assert.ok(JSON.stringify(providerRequests[0]).includes('Project notes: safe hook read'),
        'the actual Provider payload contains the Hook context');
      const observed = (globalThis as { __p11RequestHookContext?: Record<string, unknown> }).__p11RequestHookContext;
      assert.equal(observed?.extension, 'requestContext');
      assert.equal(observed?.hook, 'project-notes');
      assert.equal(observed?.sessionId, sessionId);
      assert.equal(typeof observed?.runId, 'string');
      assert.equal(observed?.source, 'human');
      assert.equal(observed?.attempt, 1);
      assert.equal(observed?.hasUserMessage, true);
      assert.equal(observed?.firstUserText, 'read request context', 'Hook inputs are immutable snapshots');
      assert.equal(observed?.deniedWrite, 'extension_request_read_only_required');
      assert.equal(existsSync(join(projectDirectory, 'hook-write.txt')), false, 'request preparation exposes only read-only Kernel tools');
      assert.ok(providerRequests[0].messages.some((message) => message.role === 'user' && message.content === 'read request context'));
    }, {
      extensions: { paths: [extensionPath], ignored: [] },
      config: { policy: { mode: 'auto' } },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      setup: async ({ projectDirectory }) => await writeFile(join(projectDirectory, 'note.txt'), 'safe hook read'),
      testDirectory: 'testplace/tmp',
    });
  } finally {
    delete (globalThis as { __p11RequestHookContext?: Record<string, unknown> }).__p11RequestHookContext;
    await rm(root, { recursive: true, force: true });
  }
});

test('a request capability saved by a Hook expires after that Hook and Run finish', { timeout: 15_000 }, async () => {
  const root = await directoryWith({
    'save-request-capability.mjs': `export default function saveRequestCapability(host) {
  globalThis.__p9P11SavedHookRequest = undefined;
  host.registerHook({ phase: 'prepareRequest', name: 'save-request', run: (context) => {
    globalThis.__p9P11SavedHookRequest = context.request;
    return { context: 'saved request capability test' };
  } });
}`,
  });
  try {
    await withTuiHost(async ({ client, sessionId, sessionDirectory }) => {
      await client.request('run.start', { sessionId, input: 'complete before reusing the saved Hook request' });
      const sessionPath = join(sessionDirectory, `${sessionId}.jsonl`);
      const before = (await readFile(sessionPath, 'utf8')).trim().split('\n').filter(Boolean);
      const saved = (globalThis as { __p9P11SavedHookRequest?: (tool: string, args: unknown) => Promise<{ text: string }> }).__p9P11SavedHookRequest;
      assert.equal(typeof saved, 'function');
      await assert.rejects(saved!('read', { path: 'note.txt' }), { code: 'extension_request_context_unavailable' });
      const after = (await readFile(sessionPath, 'utf8')).trim().split('\n').filter(Boolean);
      assert.equal(after.length, before.length, 'a stale Hook capability cannot append a tool event after the terminal');
    }, {
      extensions: { paths: [join(root, 'save-request-capability.mjs')], ignored: [] },
      config: { policy: { mode: 'auto' } },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      setup: async ({ projectDirectory }) => await writeFile(join(projectDirectory, 'note.txt'), 'review canary'),
      testDirectory: 'testplace/tmp',
    });
  } finally {
    delete (globalThis as { __p9P11SavedHookRequest?: unknown }).__p9P11SavedHookRequest;
    await rm(root, { recursive: true, force: true });
  }
});

test('factory host.request from a child Hook uses the child Kernel and mode', { timeout: 15_000 }, async () => {
  const root = await directoryWith({
    'child-factory-request.mjs': `export default function childFactoryRequest(host) {
  globalThis.__p9P11ChildFactoryRequest = undefined;
  host.registerHook({ phase: 'completeRun', name: 'read-child-note', run: async (context) => {
    if (context.parentRunId === undefined) return { decision: 'accept' };
    try {
      const read = await host.request('read', { path: 'note.txt' });
      globalThis.__p9P11ChildFactoryRequest = { text: read.text, runId: context.runId, sessionId: context.sessionId };
    } catch (error) {
      globalThis.__p9P11ChildFactoryRequest = { code: error.code, runId: context.runId, sessionId: context.sessionId };
    }
    return { decision: 'accept' };
  } });
}`,
  });
  let requestCount = 0;
  try {
    await withTuiHost(async ({ client, sessionId, sessionDirectory, providerRequests }) => {
      await client.request('run.start', { sessionId, input: JSON.stringify({
        tool: 'subagent_start', args: {
          task: 'child Hook must use its own Kernel', mode: { type: 'inline', tools: ['find'], prompt: [] },
        },
      }) });
      const observed = (globalThis as { __p9P11ChildFactoryRequest?: Record<string, unknown> }).__p9P11ChildFactoryRequest;
      assert.ok(observed, 'the child completion Hook ran');
      assert.notEqual(observed.sessionId, sessionId);
      assert.equal(observed.code, 'tool_denied', 'the child Kernel denies read because its Mode exposes only find');
      assert.equal(providerRequests.length, 3);
      const parent = (await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8')).trim().split('\n')
        .filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(parent.filter((event) => event.kind === 'tool' && event.runId === observed.runId).length, 0,
        'a child Hook request cannot write its event into the parent Session');
      const child = (await readFile(join(sessionDirectory, `${String(observed.sessionId)}.jsonl`), 'utf8')).trim().split('\n')
        .filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      const childRead = child.find((event) => event.kind === 'tool' && event.tool === 'read') as {
        result?: { code?: string };
      } | undefined;
      assert.equal(childRead?.result?.code, 'tool_denied');
    }, {
      extensions: { paths: [join(root, 'child-factory-request.mjs')], ignored: [] },
      config: { loop: { iterations: 3, modelCalls: 3, totalModelCalls: 6 }, policy: { mode: 'auto' } },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      beforeResponse: (body) => {
        requestCount += 1;
        if (requestCount < 3) return;
        const lastUser = [...body.messages].reverse().find((message) => message.role === 'user');
        if (typeof lastUser?.content === 'string' && lastUser.content.includes('"tool":"subagent_start"')) {
          lastUser.content = 'parent finishes after checking the child';
        }
      },
      setup: async ({ projectDirectory }) => await writeFile(join(projectDirectory, 'note.txt'), 'review canary'),
      testDirectory: 'testplace/tmp',
    });
  } finally {
    delete (globalThis as { __p9P11ChildFactoryRequest?: Record<string, unknown> }).__p9P11ChildFactoryRequest;
    await rm(root, { recursive: true, force: true });
  }
});

test('a completed child result remains readable after Host restart when boundary is narrower than projectRoot', { timeout: 20_000 }, async () => {
  let releaseParent!: () => void;
  const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
  const config: Record<string, unknown> = { loop: { iterations: 8, modelCalls: 8 }, policy: { mode: 'auto' } };
  let parentReached = false;
  try {
    await withTuiHost(async ({ client, sessionId, restart, projectDirectory }) => {
      const parent = await client.request('run.submit', { sessionId, input: 'hold parent while the child completes' }) as { runId: string };
      await waitFor(() => parentReached, { within: 5_000 });
      const child = await client.request('subrun.start', {
        sessionId, parentRunId: parent.runId, task: 'review child result after restart',
      }) as { subrunId: string };
      const finished = await client.request('subrun.wait', {
        sessionId, parentRunId: parent.runId, subrunIds: [child.subrunId], timeoutMs: 5_000,
      }) as { subruns: { state: string }[] };
      assert.equal(finished.subruns[0]?.state, 'completed');
      releaseParent();
      await client.request('run.wait', { sessionId, runId: parent.runId });
      const reopened = await restart();
      await reopened.request('session.open', { sessionId, projectRoot: projectDirectory });
      const persisted = await reopened.request('subrun.status', {
        sessionId, parentRunId: parent.runId, subrunId: child.subrunId,
      }) as { state: string; errorCode?: string; result?: unknown };
      assert.equal(persisted.state, 'completed');
      assert.equal(persisted.errorCode, undefined);
      assert.ok(persisted.result, 'the durable child RunResult remains readable after restart');
    }, {
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      config,
      testDirectory: 'testplace/tmp',
      beforeResponse: async (body) => {
        if (body.messages.some((message) => message.role === 'user' && message.content === 'hold parent while the child completes')) {
          parentReached = true;
          await parentGate;
        }
      },
      setup: async ({ projectDirectory }) => {
        config.workspaceRoot = projectDirectory;
        config.boundary = join(projectDirectory, 'narrow');
        await mkdir(String(config.boundary));
      },
    });
  } finally {
    releaseParent();
  }
});

test('request preparation Hook output is bounded by the existing prompt-fragment limit', { timeout: 10_000 }, async () => {
  const root = await directoryWith({
    'oversize-context.mjs': `export default function oversize(host) {
  host.registerHook({ phase: 'prepareRequest', name: 'oversize', run: () => ({ context: 'x'.repeat(8_001) }) });
}`,
  });
  try {
    await withTuiHost(async ({ client, sessionId, providerRequests }) => {
      const accepted = await client.request('run.submit', { sessionId, input: 'reject the oversized extension context' }) as { runId: string };
      await assert.rejects(client.request('run.wait', { sessionId, runId: accepted.runId }), { code: 'extension_hook_context_too_large' });
      assert.equal(providerRequests.length, 0, 'the Provider must not receive an oversized prepared request');
    }, {
      extensions: { paths: [join(root, 'oversize-context.mjs')], ignored: [] },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      config: { policy: { mode: 'auto' } },
      testDirectory: 'testplace/tmp',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('request preparation counts the separators between labeled Hook contexts', async () => {
  const root = await directoryWith({
    'first.mjs': `export default function e1(host) {
  host.registerHook({ phase: 'prepareRequest', name: 'a', run: () => ({ context: 'x' }) });
}`,
    'second.mjs': `export default function e2(host) {
  host.registerHook({ phase: 'prepareRequest', name: 'b', run: () => ({ context: 'y' }) });
}`,
  });
  const loaded = await loadExtensions([join(root, 'first.mjs'), join(root, 'second.mjs')], {
    registerTool: () => () => {},
    registerFragment: () => () => {},
    addEventListener: () => () => {},
    request: async () => undefined,
  });
  try {
    await assert.rejects(prepareExtensionRequest(loaded.hooks, {
      sessionId: 'extension-context-session',
      runId: 'extension-context-run',
      source: 'human',
      requestId: 'extension-context-request',
      attempt: 1,
      system: '',
      tools: [],
      messages: [],
      signal: new AbortController().signal,
      request: async () => undefined,
    }, 16), { code: 'extension_hook_context_too_large' });
  } finally {
    await loaded.dispose();
  }
});

test('completeRun Hook can require another bounded request before the Run succeeds', { timeout: 15_000 }, async () => {
  await withTuiHost(async ({ client, sessionId, sessionDirectory, projectDirectory, providerRequests }) => {
      await writeFile(join(projectDirectory, 'README.md'), 'P11_EXTENSION_DEMO_CONTEXT_SOURCE: project note for the request Hook.');
      await writeFile(join(projectDirectory, 'verification.txt'), 'PASS');
      await client.request('run.start', { sessionId, input: 'P11_EXTENSION_DEMO' });
      assert.equal(providerRequests.length, 2, 'a continue decision consumes another Provider request in the same Run');
      const firstSystem = providerRequests[0].messages.find((message) => message.role === 'system')?.content;
      const secondSystem = providerRequests[1].messages.find((message) => message.role === 'system')?.content;
      assert.equal(typeof firstSystem, 'string');
      assert.ok((firstSystem as string).includes('P11_EXTENSION_DEMO_CONTEXT_SOURCE'));
      assert.equal(typeof secondSystem, 'string');
      assert.ok((secondSystem as string).includes('P11_EXTENSION_DEMO_CHECK'));
      const events = (await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8')).split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const reads = events.filter((event) => event.kind === 'tool' && event.tool === 'read');
      assert.equal(reads.length, 3, 'two request-context reads and one completion check use the Kernel read tool');
      const user = events.find((event) => event.kind === 'user' && typeof event.text === 'string'
        && event.text.includes('P11_EXTENSION_DEMO')) as { run?: { runId?: string } } | undefined;
      assert.equal(typeof user?.run?.runId, 'string');
      assert.ok(reads.every((event) => event.runId === user?.run?.runId));
      assert.ok(reads.every((event) => typeof event.parentCallId === 'string'));
    }, {
      extensions: { paths: [projectContextExtension], ignored: [] },
      config: { policy: { mode: 'auto' } },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      testDirectory: 'testplace/tmp',
    });
});

test('the project-audit example routes read, search, and exec through the active Kernel Run', { timeout: 30_000 }, async () => {
  await withTuiHost(async ({ client, sessionId, sessionDirectory, projectDirectory, providerRequests }) => {
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', {
      sessionId,
      input: JSON.stringify({ tool: 'project_audit', args: { path: 'notes.txt', pattern: 'Needle' } }),
    });
    const events = (await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8')).split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const outer = events.findLast((event) => event.kind === 'tool' && event.tool === 'project_audit') as {
      callId?: string; runId?: string;
    } | undefined;
    assert.equal(typeof outer?.callId, 'string');
    const nested = events.filter((event) => event.kind === 'tool'
      && ['read', 'search', 'exec'].includes(String(event.tool)));
    assert.deepEqual(nested.map((event) => event.tool), ['read', 'search', 'exec']);
    assert.ok(nested.every((event) => event.parentCallId === outer?.callId), 'each nested tool call is recorded under its extension tool');
    assert.ok(nested.every((event) => event.runId === outer?.runId), 'nested calls remain bound to the same Run');
    assert.ok(JSON.stringify(providerRequests).includes('Needle appears here'));
    assert.match(JSON.stringify(providerRequests), /v\d+\.\d+\.\d+/);
  }, {
    extensions: { paths: [projectAuditExtension], ignored: [] },
    config: { policy: { mode: 'ask' } },
    permission: fullAccess,
    interactive: true,
    permissionControl: true,
    modeName: 'full',
    setup: async ({ projectDirectory }) => await writeFile(join(projectDirectory, 'notes.txt'), 'Needle appears here.\n'),
    testDirectory: 'testplace/tmp',
  });
});

test('the project-context example receives child Run identity and executes through the child Kernel', { timeout: 20_000 }, async () => {
  const root = await directoryWith({
    'observe-child.mjs': `export default function observeChild(host) {
  globalThis.__p11ObservedCompletionRuns = [];
  host.registerHook({ phase: 'completeRun', name: 'observe-child-scope', run: (context) => {
    globalThis.__p11ObservedCompletionRuns.push({
      sessionId: context.sessionId,
      runId: context.runId,
      source: context.source,
      parentRunId: context.parentRunId,
      parentCallId: context.parentCallId,
      userSeq: context.userSeq,
      candidate: context.candidate,
    });
    return { decision: 'accept' };
  } });
}`,
  });
  let requestCount = 0;
  try {
    await withTuiHost(async ({ client, sessionId, sessionDirectory, providerRequests }) => {
      await client.request('run.start', {
        sessionId,
        input: JSON.stringify({ tool: 'subagent_start', args: { task: 'P11_EXTENSION_DEMO child task' } }),
      });
      assert.equal(providerRequests.length, 4, 'the parent and child each make their initial and continuation requests');
      assert.ok(providerRequests.some((request) => JSON.stringify(request).includes('P11_EXTENSION_DEMO_CHECK')),
        'the child completion decision reaches the child Provider request');
      const scopes = (globalThis as { __p11ObservedCompletionRuns?: Record<string, unknown>[] }).__p11ObservedCompletionRuns ?? [];
      const parent = scopes.find((scope) => scope.sessionId === sessionId) as {
        runId?: string;
      } | undefined;
      const child = scopes.find((scope) => scope.sessionId !== sessionId) as {
        sessionId?: string; runId?: string; source?: string; parentRunId?: string; parentCallId?: string;
        userSeq?: number; candidate?: { fromSeq?: number; toSeq?: number; id?: string };
      } | undefined;
      assert.equal(typeof parent?.runId, 'string');
      assert.equal(typeof child?.sessionId, 'string');
      assert.notEqual(child?.sessionId, sessionId);
      assert.equal(child?.source, 'controller');
      assert.equal(child?.parentRunId, parent?.runId);
      assert.equal(typeof child?.parentCallId, 'string');
      assert.equal(child?.candidate?.fromSeq, child?.userSeq);
      assert.ok(typeof child?.candidate?.toSeq === 'number' && child.candidate.toSeq >= child.userSeq!);
      const childEvents = (await readFile(join(sessionDirectory, `${child!.sessionId}.jsonl`), 'utf8')).split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const childReads = childEvents.filter((event) => event.kind === 'tool' && event.tool === 'read');
      assert.ok(childReads.length >= 3, 'request context and completion checks use the child Session Kernel');
      assert.ok(childReads.every((event) => event.runId === child?.runId));
    }, {
      extensions: { paths: [projectContextExtension, join(root, 'observe-child.mjs')], ignored: [] },
      config: { loop: { iterations: 4, modelCalls: 4, totalModelCalls: 8 }, policy: { mode: 'auto' } },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      beforeResponse: (body) => {
        requestCount += 1;
        if (requestCount < 3) return;
        const lastUser = [...body.messages].reverse().find((message) => message.role === 'user');
        if (typeof lastUser?.content === 'string' && lastUser.content.includes('"tool":"subagent_start"')) {
          lastUser.content = 'P11 parent finishes after the child';
        }
      },
      setup: async ({ projectDirectory }) => {
        await writeFile(join(projectDirectory, 'README.md'), 'P11_EXTENSION_DEMO_CONTEXT_SOURCE: child request context.');
        await writeFile(join(projectDirectory, 'verification.txt'), 'PASS');
      },
      testDirectory: 'testplace/tmp',
    });
  } finally {
    delete (globalThis as { __p11ObservedCompletionRuns?: Record<string, unknown>[] }).__p11ObservedCompletionRuns;
    await rm(root, { recursive: true, force: true });
  }
});

test('configured Hooks load when the TUI Host reopens a Session with full-access and unrestricted network', { timeout: 15_000 }, async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
    await writeFile(join(projectDirectory, 'README.md'), 'P11_EXTENSION_DEMO_CONTEXT_SOURCE: reopen project note.');
    await writeFile(join(projectDirectory, 'verification.txt'), 'PASS');
    await client.request('run.start', { sessionId, input: 'P11_EXTENSION_DEMO' });
    assert.equal(providerRequests.length, 1, 'the initial read-only Session does not load configured executable extensions');
    await client.request('permission.set', {
      sessionId,
      permissionProfile: 'full-access',
      permissionNetwork: 'unrestricted',
      confirmFullAccess: true,
      confirmNetwork: true,
    });
    await client.request('session.close', { sessionId });
    await client.request('session.open', { projectRoot: projectDirectory, sessionId });
    await client.request('run.start', { sessionId, input: 'P11_EXTENSION_DEMO' });
    assert.equal(providerRequests.length, 3, 'the reopened Session runs the prepare and completion Hooks');
    assert.ok(JSON.stringify(providerRequests.slice(1)).includes('P11_EXTENSION_DEMO_CONTEXT_SOURCE'));
    assert.ok(JSON.stringify(providerRequests.slice(1)).includes('P11_EXTENSION_DEMO_CHECK'));
  }, {
    extensions: { paths: [projectContextExtension], ignored: [] },
    permission: createPermissionContext('read-only', 'policy', fullAccess.capabilities),
    permissionControl: true,
    config: { policy: { mode: 'auto' } },
    modeName: 'full',
    testDirectory: 'testplace/tmp',
  });
});

test('a completion candidate closes child admission until its Hook accepts or continues', { timeout: 20_000 }, async () => {
  let releaseCandidate!: () => void;
  const candidateGate = new Promise<void>((resolve) => { releaseCandidate = resolve; });
  const reviewGlobals = globalThis as typeof globalThis & {
    __p11CandidateGate?: Promise<void>;
    __p11CandidateChecked?: string;
  };
  const root = await directoryWith({
    'hold-completion.mjs': `export default function holdCompletion(host) {
  host.registerHook({ phase: 'completeRun', name: 'verify-while-children-are-closed', run: async (context) => {
    if (context.parentRunId !== undefined || !context.summary.text.includes('P11_COMPLETION_GATE')) return { decision: 'accept' };
    const result = await context.request('read', { path: 'verification.txt' });
    globalThis.__p11CandidateChecked = result.text.trim();
    await globalThis.__p11CandidateGate;
    return result.text.trim() === 'PASS' ? { decision: 'accept' } : { decision: 'fail', reason: 'verification changed' };
  } });
}`,
  });
  reviewGlobals.__p11CandidateGate = candidateGate;
  delete reviewGlobals.__p11CandidateChecked;
  try {
    await withTuiHost(async ({ client, sessionId, sessionDirectory, projectDirectory }) => {
      const parent = await client.request('run.submit', { sessionId, input: 'P11_COMPLETION_GATE' }) as { runId: string };
      await waitFor(() => reviewGlobals.__p11CandidateChecked === 'PASS', { within: 5_000 });
      let child: { subrunId: string } | undefined;
      try {
        const startingChild = client.request('subrun.start', {
          sessionId,
          parentRunId: parent.runId,
          task: JSON.stringify({ tool: 'edit', args: { path: 'verification.txt', anchor: 'PASS', replacement: 'FAIL' } }),
        }).then((result) => { child = result as { subrunId: string }; return result; });
        await assert.rejects(startingChild, { code: 'subagent_parent_not_active' });
      } finally {
        releaseCandidate();
        if (child !== undefined) {
          await client.request('subrun.wait', { sessionId, parentRunId: parent.runId,
            subrunIds: [child.subrunId], timeoutMs: 5_000 }).catch(() => undefined);
        }
      }
      await client.request('run.wait', { sessionId, runId: parent.runId });
      assert.equal(await readFile(join(projectDirectory, 'verification.txt'), 'utf8'), 'PASS');
      const events = (await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8')).split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const terminal = events.findLast((event) => event.kind === 'turn' && event.runId === parent.runId);
      assert.equal(terminal?.status, 'completed');
    }, {
      extensions: { paths: [join(root, 'hold-completion.mjs')], ignored: [] },
      config: { policy: { mode: 'auto' } },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      setup: async ({ projectDirectory }) => await writeFile(join(projectDirectory, 'verification.txt'), 'PASS'),
      testDirectory: 'testplace/tmp',
    });
  } finally {
    releaseCandidate();
    delete reviewGlobals.__p11CandidateGate;
    delete reviewGlobals.__p11CandidateChecked;
    await rm(root, { recursive: true, force: true });
  }
});

test('accepted child steering invalidates its pending approval before a late allow arrives', { timeout: 20_000 }, async () => {
  let releaseParent!: () => void;
  let resolveApproval!: (value: { decision: 'allow' | 'deny' }) => void;
  const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
  const approvalGate = new Promise<{ decision: 'allow' | 'deny' }>((resolve) => { resolveApproval = resolve; });
  let parentReached = false;
  let approvalReached = false;
  try {
    await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
      client.onRequest((message) => {
        if (message.method !== 'approval.request') return undefined;
        approvalReached = true;
        return approvalGate;
      });
      const parent = await client.request('run.submit', { sessionId, input: 'hold the parent during child approval' }) as { runId: string };
      await waitFor(() => parentReached, { within: 5_000 });
      const child = await client.request('subrun.start', {
        sessionId,
        parentRunId: parent.runId,
        task: JSON.stringify({ tool: 'create', args: { path: 'must-not-be-created.txt', content: 'late approval' } }),
      }) as { subrunId: string; runId: string };
      await waitFor(() => approvalReached, { within: 5_000 });
      const accepted = await client.request('subrun.message', {
        sessionId,
        parentRunId: parent.runId,
        subrunId: child.subrunId,
        runId: child.runId,
        input: 'Do not create that file. Return without changing anything.',
      }) as { state: string };
      assert.equal(accepted.state, 'accepted');
      resolveApproval({ decision: 'allow' });
      await client.request('subrun.wait', {
        sessionId,
        parentRunId: parent.runId,
        subrunIds: [child.subrunId],
        timeoutMs: 5_000,
      });
      assert.equal(existsSync(join(projectDirectory, 'must-not-be-created.txt')), false,
        'a late answer cannot authorize the request that preceded accepted child input');
      releaseParent();
      await client.request('run.wait', { sessionId, runId: parent.runId });
    }, {
      config: { loop: { iterations: 4, modelCalls: 4 }, policy: { mode: 'ask' } },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      beforeResponse: async (body) => {
        if (body.messages.some((message) => message.role === 'user' && message.content === 'hold the parent during child approval')) {
          parentReached = true;
          await parentGate;
        }
      },
      testDirectory: 'testplace/tmp',
    });
  } finally {
    resolveApproval({ decision: 'deny' });
    releaseParent();
  }
});

test('completion failure outranks an earlier continue decision and runs the remaining checks', { timeout: 15_000 }, async () => {
  const root = await directoryWith({
    'completion-order.mjs': `export default function completionOrder(host) {
  globalThis.__p11CompletionOrder = [];
  host.registerHook({ phase: 'completeRun', name: 'ask-to-continue', run: () => {
    globalThis.__p11CompletionOrder.push('continue');
    return { decision: 'continue', reason: 'one more check is needed' };
  } });
  host.registerHook({ phase: 'completeRun', name: 'reject', run: () => {
    globalThis.__p11CompletionOrder.push('fail');
    return { decision: 'fail', reason: 'the required artifact is missing' };
  } });
}`,
  });
  try {
    await withTuiHost(async ({ client, sessionId, providerRequests }) => {
      await assert.rejects(client.request('run.start', { sessionId, input: 'Finish the task.' }), (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'extension_completion_rejected');
        assert.match((error as { detail?: string }).detail ?? '', /the required artifact is missing/);
        return true;
      });
      assert.equal(providerRequests.length, 1, 'a failure must prevent the continuation request');
      assert.deepEqual((globalThis as { __p11CompletionOrder?: string[] }).__p11CompletionOrder, ['continue', 'fail']);
    }, {
      extensions: { paths: [join(root, 'completion-order.mjs')], ignored: [] },
      config: { policy: { mode: 'auto' } },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      testDirectory: 'testplace/tmp',
    });
  } finally {
    delete (globalThis as { __p11CompletionOrder?: string[] }).__p11CompletionOrder;
    await rm(root, { recursive: true, force: true });
  }
});

test('a later completion Hook exception overrides continuation without persisting its error text', { timeout: 15_000 }, async () => {
  const root = await directoryWith({
    'completion-exception.mjs': `export default function completionException(host) {
  globalThis.__p11CompletionExceptionOrder = [];
  host.registerHook({ phase: 'completeRun', name: 'continue-first', run: () => {
    globalThis.__p11CompletionExceptionOrder.push('continue');
    return { decision: 'continue', reason: 'one more check is needed' };
  } });
  host.registerHook({ phase: 'completeRun', name: 'throw-secret', run: () => {
    globalThis.__p11CompletionExceptionOrder.push('throw');
    throw new Error('private token must not be recorded');
  } });
}`,
  });
  try {
    await withTuiHost(async ({ client, sessionId, providerRequests, sessionDirectory }) => {
      await assert.rejects(client.request('run.start', { sessionId, input: 'Finish the task.' }), { code: 'extension_hook_failed' });
      assert.equal(providerRequests.length, 1);
      assert.deepEqual((globalThis as { __p11CompletionExceptionOrder?: string[] }).__p11CompletionExceptionOrder, ['continue', 'throw']);
      const sessionText = await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8');
      assert.equal(sessionText.includes('private token must not be recorded'), false);
    }, {
      extensions: { paths: [join(root, 'completion-exception.mjs')], ignored: [] },
      config: { policy: { mode: 'auto' } },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      testDirectory: 'testplace/tmp',
    });
  } finally {
    delete (globalThis as { __p11CompletionExceptionOrder?: string[] }).__p11CompletionExceptionOrder;
    await rm(root, { recursive: true, force: true });
  }
});

test('cancelling a running completion Hook prevents its late accept from completing the Run', { timeout: 15_000 }, async () => {
  const root = await directoryWith({
    'slow-completion.mjs': `export default function slowCompletion(host) {
  globalThis.__p11SlowCompletionStarted = false;
  globalThis.__p11SlowCompletionSettled = false;
  host.registerHook({ phase: 'completeRun', name: 'slow-check', run: async () => {
    globalThis.__p11SlowCompletionStarted = true;
    await new Promise((resolve) => setTimeout(resolve, 150));
    globalThis.__p11SlowCompletionSettled = true;
    return { decision: 'accept' };
  } });
}`,
  });
  try {
    await withTuiHost(async ({ client, sessionId, sessionDirectory }) => {
      const accepted = await client.request('run.submit', { sessionId, input: 'Finish after a slow check.' }) as { runId: string };
      await waitFor(() => (globalThis as { __p11SlowCompletionStarted?: boolean }).__p11SlowCompletionStarted === true);
      await client.request('run.cancel', { sessionId });
      await assert.rejects(client.request('run.wait', { sessionId, runId: accepted.runId }), (error) =>
        ['loop_cancelled', 'task_cancelled'].includes((error as { code?: string }).code ?? ''));
      await delay(200);
      assert.equal((globalThis as { __p11SlowCompletionSettled?: boolean }).__p11SlowCompletionSettled, true,
        'trusted extension code may settle after cancellation');
      const events = (await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8')).split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const turns = events.filter((event) => event.kind === 'turn');
      assert.equal(turns.length, 1);
      assert.equal(turns[0].status, 'cancelled', 'the late accept cannot replace the persisted cancellation');
    }, {
      extensions: { paths: [join(root, 'slow-completion.mjs')], ignored: [] },
      config: { policy: { mode: 'auto' } },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      testDirectory: 'testplace/tmp',
    });
  } finally {
    delete (globalThis as { __p11SlowCompletionStarted?: boolean }).__p11SlowCompletionStarted;
    delete (globalThis as { __p11SlowCompletionSettled?: boolean }).__p11SlowCompletionSettled;
    await rm(root, { recursive: true, force: true });
  }
});

test('completion continuation invalidates an earlier structured submission', { timeout: 15_000 }, async () => {
  const root = await directoryWith({
    'structured-completion.mjs': `export default function structuredCompletion(host) {
  globalThis.__p11StructuredCompletionChecks = 0;
  globalThis.__p11StructuredCompletionContext = undefined;
  host.registerHook({ phase: 'completeRun', name: 'verify-submission', run: (context) => {
    globalThis.__p11StructuredCompletionChecks += 1;
    globalThis.__p11StructuredCompletionContext = {
      candidate: context.candidate,
      structuredDigest: context.structuredDigest,
      userSeq: context.userSeq,
    };
    return { decision: 'continue', reason: 'Submit the structured result again after the final check.' };
  } });
}`,
  });
  try {
    await withTuiHost(async ({ client, sessionId, providerRequests }) => {
      await assert.rejects(client.request('run.start', {
        sessionId,
        input: JSON.stringify({ tool: 'ligule_delegation_result', args: { result: { answer: 'ready' } } }),
        delegation: { outputSchema: {
          type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false,
        } },
      }), { code: 'delegation_result_missing' });
      assert.equal(providerRequests.length, 2, 'the Hook continuation must return to the Provider');
      assert.ok(JSON.stringify(providerRequests[1]).includes('Submit the structured result again after the final check.'));
      assert.equal((globalThis as { __p11StructuredCompletionChecks?: number }).__p11StructuredCompletionChecks, 1,
        'the second candidate fails the existing structured-output check before another completion Hook runs');
      const context = (globalThis as { __p11StructuredCompletionContext?: Record<string, unknown> }).__p11StructuredCompletionContext;
      assert.equal(typeof context?.structuredDigest, 'string', 'the check is bound to a digest of the accepted structured output');
      const candidate = context?.candidate as { fromSeq?: number; toSeq?: number } | undefined;
      assert.equal(candidate?.fromSeq, context?.userSeq);
      assert.ok(typeof candidate?.toSeq === 'number' && candidate.toSeq >= candidate.fromSeq!);
    }, {
      extensions: { paths: [join(root, 'structured-completion.mjs')], ignored: [] },
      config: { policy: { mode: 'auto' } },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      beforeResponse: (body) => {
        if (body.messages.some((message) => message.role === 'assistant')) {
          const lastUser = [...body.messages].reverse().find((message) => message.role === 'user');
          if (lastUser !== undefined) lastUser.content = 'Continue without submitting another structured result.';
        }
      },
      testDirectory: 'testplace/tmp',
    });
  } finally {
    delete (globalThis as { __p11StructuredCompletionChecks?: number }).__p11StructuredCompletionChecks;
    delete (globalThis as { __p11StructuredCompletionContext?: Record<string, unknown> }).__p11StructuredCompletionContext;
    await rm(root, { recursive: true, force: true });
  }
});

test('completion continuation consumes the existing model-call budget', { timeout: 15_000 }, async () => {
  const root = await directoryWith({
    'completion-budget.mjs': `export default function completionBudget(host) {
  globalThis.__p11CompletionBudgetChecks = 0;
  host.registerHook({ phase: 'completeRun', name: 'always-continue', run: () => {
    globalThis.__p11CompletionBudgetChecks += 1;
    return { decision: 'continue', reason: 'one more check is required' };
  } });
}`,
  });
  try {
    await withTuiHost(async ({ client, sessionId, providerRequests }) => {
      await assert.rejects(client.request('run.start', { sessionId, input: 'Finish the task.' }), { code: 'loop_model_budget_exhausted' });
      assert.equal(providerRequests.length, 1, 'the continuation cannot exceed the existing one-call Run budget');
      assert.equal((globalThis as { __p11CompletionBudgetChecks?: number }).__p11CompletionBudgetChecks, 1);
    }, {
      extensions: { paths: [join(root, 'completion-budget.mjs')], ignored: [] },
      config: { loop: { iterations: 4, modelCalls: 1 }, policy: { mode: 'auto' } },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      testDirectory: 'testplace/tmp',
    });
  } finally {
    delete (globalThis as { __p11CompletionBudgetChecks?: number }).__p11CompletionBudgetChecks;
    await rm(root, { recursive: true, force: true });
  }
});

test('completion feedback across candidates stays within the existing prompt-fragment limit', { timeout: 15_000 }, async () => {
  const root = await directoryWith({
    'completion-context-limit.mjs': `export default function completionContextLimit(host) {
  for (let index = 0; index < 8; index += 1) {
    host.registerHook({ phase: 'completeRun', name: 'bounded-feedback-' + index, run: () => ({
      decision: 'continue', reason: 'x'.repeat(500),
    }) });
  }
}`,
  });
  try {
    await withTuiHost(async ({ client, sessionId, providerRequests }) => {
      await assert.rejects(client.request('run.start', { sessionId, input: 'Finish the task.' }), { code: 'extension_hook_context_too_large' });
      assert.equal(providerRequests.length, 2, 'oversized cumulative feedback stops before another Provider request');
      assert.ok(JSON.stringify(providerRequests[1]).includes('x'.repeat(500)), 'the first bounded continuation reaches its next request');
    }, {
      extensions: { paths: [join(root, 'completion-context-limit.mjs')], ignored: [] },
      config: { policy: { mode: 'auto' } },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      testDirectory: 'testplace/tmp',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('beforeTool Hook can add a denial without executing the tool or bypassing the Kernel record', { timeout: 15_000 }, async () => {
  const root = await directoryWith({
    'deny-create.mjs': `export default function denyCreate(host) {
  globalThis.__p11LaterBeforeTool = 0;
  host.registerHook({ phase: 'beforeTool', name: 'deny-create', run: (context) =>
    context.tool === 'create' ? { decision: 'deny', reason: 'P11 test denial' } : { decision: 'continue' } });
  host.registerHook({ phase: 'beforeTool', name: 'attempt-override', run: () => {
    globalThis.__p11LaterBeforeTool += 1;
    return { decision: 'continue' };
  } });
}`,
  });
  const extensionPath = join(root, 'deny-create.mjs');
  try {
    await withTuiHost(async ({ client, sessionId, sessionDirectory, projectDirectory }) => {
      await client.request('run.start', {
        sessionId,
        input: JSON.stringify({ tool: 'create', args: { path: 'hook-denied.txt', content: 'must remain absent' } }),
      });
      assert.equal(existsSync(join(projectDirectory, 'hook-denied.txt')), false, 'the additional refusal happens before tool execution');
      const events = (await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8')).split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const result = events.findLast((event) => event.kind === 'tool' && event.tool === 'create')?.result as {
        failed?: boolean; code?: string;
      } | undefined;
      assert.equal(result?.failed, true);
      assert.equal(result?.code, 'extension_hook_denied');
      assert.equal((globalThis as { __p11LaterBeforeTool?: number }).__p11LaterBeforeTool, 0,
        'a later Hook cannot override an earlier Hook refusal');
    }, {
      extensions: { paths: [extensionPath], ignored: [] },
      config: { policy: { mode: 'auto' } },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      testDirectory: 'testplace/tmp',
    });
  } finally {
    delete (globalThis as { __p11LaterBeforeTool?: number }).__p11LaterBeforeTool;
    await rm(root, { recursive: true, force: true });
  }
});

test('beforeTool Hook exceptions fail and persist the call without running the tool', { timeout: 15_000 }, async () => {
  const root = await directoryWith({
    'throw-before-tool.mjs': `export default function throwBeforeTool(host) {
  host.registerHook({ phase: 'beforeTool', name: 'reject-create', run: (context) => {
    if (context.tool === 'create') throw new Error('private before-tool detail');
    return { decision: 'continue' };
  } });
}`,
  });
  try {
    await withTuiHost(async ({ client, sessionId, sessionDirectory, projectDirectory }) => {
      await client.request('run.start', { sessionId, input: JSON.stringify({
        tool: 'create', args: { path: 'hook-error.txt', content: 'must stay absent' },
      }) });
      assert.equal(existsSync(join(projectDirectory, 'hook-error.txt')), false);
      const sessionText = await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8');
      const events = sessionText.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      const result = events.findLast((event) => event.kind === 'tool' && event.tool === 'create')?.result as {
        code?: string; failed?: boolean;
      } | undefined;
      assert.equal(result?.failed, true);
      assert.equal(result?.code, 'extension_hook_failed');
      assert.equal(sessionText.includes('private before-tool detail'), false);
    }, {
      extensions: { paths: [join(root, 'throw-before-tool.mjs')], ignored: [] },
      config: { policy: { mode: 'auto' } },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      testDirectory: 'testplace/tmp',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a Kernel permission denial happens before beforeTool Hooks', async () => {
  const root = await directoryWith({
    'observe-before-tool.mjs': `export default function observeBeforeTool(host) {
  globalThis.__p11HardDeniedBeforeToolCalls = 0;
  host.registerHook({ phase: 'beforeTool', name: 'observe-denied-write', run: () => {
    globalThis.__p11HardDeniedBeforeToolCalls += 1;
    return { decision: 'continue' };
  } });
}`,
  });
  const session = createSessionLog({ directory: root, id: 'before-tool-permission-denial' });
  let hooks: Awaited<ReturnType<typeof loadExtensions>> | undefined;
  const kernel = createKernel({
    config: createConfig({ user: { boundary: root } }),
    permission: createPermissionContext('read-only', 'disabled', {
      filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
    }),
    session,
    extensionHooks: () => hooks?.hooks,
  });
  minimalPlugin.setup(kernel);
  try {
    hooks = await loadExtensions([join(root, 'observe-before-tool.mjs')], {
      registerTool: (tool) => kernel.register(tool as ToolDefinition),
      registerFragment: () => () => {},
      addEventListener: () => () => {},
      request: (name, args) => kernel.call(name, args),
    });
    await assert.rejects(kernel.call('create', { path: 'permission-denied.txt', content: 'must not exist' }, {
      sessionId: 'before-tool-permission-denial', runId: 'p11-permission-denial', callId: 'p11-permission-denial-call',
    }), { code: 'permission_read_only' });
    assert.equal((globalThis as { __p11HardDeniedBeforeToolCalls?: number }).__p11HardDeniedBeforeToolCalls, 0);
    assert.equal(existsSync(join(root, 'permission-denied.txt')), false);
    const event = (await session.read()).find((entry) => entry.kind === 'tool');
    assert.equal((event?.result as { code?: string }).code, 'permission_read_only');
  } finally {
    await hooks?.dispose();
    await session.close();
    delete (globalThis as { __p11HardDeniedBeforeToolCalls?: number }).__p11HardDeniedBeforeToolCalls;
    await rm(root, { recursive: true, force: true });
  }
});

test('afterTool Hook observes the persisted result and its failure cannot change execution', { timeout: 15_000 }, async () => {
  const root = await directoryWith({
    'observe-tool.mjs': `export default function observeTool(host) {
  host.registerHook({ phase: 'afterTool', name: 'observe-create', run: async (context) => {
    if (context.tool !== 'create') return;
    globalThis.__p11AfterToolResult = {
      sessionId: context.sessionId, runId: context.runId, source: context.source,
      callId: context.callId, tool: context.tool, outcome: context.outcome,
      durationMs: context.durationMs, eventSeq: context.eventSeq, result: context.result,
    };
    throw new Error('observer secret detail must not alter the tool result');
  } });
}`,
  });
  const extensionPath = join(root, 'observe-tool.mjs');
  try {
    await withTuiHost(async ({ client, sessionId, sessionDirectory, projectDirectory }) => {
      await client.request('run.start', { sessionId, input: JSON.stringify({
        tool: 'create', args: { path: 'observer-result.txt', content: 'created before observer' },
      }) });
      assert.equal(await readFile(join(projectDirectory, 'observer-result.txt'), 'utf8'), 'created before observer');
      const observed = (globalThis as { __p11AfterToolResult?: Record<string, unknown> }).__p11AfterToolResult;
      assert.equal(observed?.sessionId, sessionId);
      assert.equal(typeof observed?.runId, 'string');
      assert.equal(observed?.source, 'human');
      assert.equal(observed?.tool, 'create');
      assert.equal(observed?.outcome, 'completed');
      assert.equal(typeof observed?.callId, 'string');
      assert.equal(typeof observed?.durationMs, 'number');
      const events = (await readFile(join(sessionDirectory, `${sessionId}.jsonl`), 'utf8')).split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const event = events.find((entry) => entry.kind === 'tool' && entry.tool === 'create')!;
      assert.equal(observed?.eventSeq, event.seq, 'the observer runs after its result event was persisted');
      assert.deepEqual(JSON.parse(JSON.stringify(observed?.result)), event.result);
      assert.equal(JSON.stringify(events).includes('observer secret detail'), false, 'observer error text is not persisted');
    }, {
      extensions: { paths: [extensionPath], ignored: [] },
      config: { policy: { mode: 'auto' } },
      permission: fullAccess,
      permissionControl: true,
      modeName: 'full',
      testDirectory: 'testplace/tmp',
    });
  } finally {
    delete (globalThis as { __p11AfterToolResult?: Record<string, unknown> }).__p11AfterToolResult;
    await rm(root, { recursive: true, force: true });
  }
});
