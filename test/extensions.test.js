// 第 29 步的验收（D37、D46、D68）：扩展从哪几处来、递出去的面有多大、装坏了留什么。
// 临时目录里的模块是真的 ESM 文件，用真的动态 import 跑；内核、判定链、提示词组装也都是真的。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createConfig, createKernel, extensionSources, loadAssembly, loadExtensions, minimalPlugin,
} from '../dist/index.js';

const shippedModes = fileURLToPath(new URL('../modes/', import.meta.url));

// 每一条测试都要一份真的临时目录（扩展文件是被真动态 import 的），跑完一起收掉。
const created = [];
async function directoryWith(files) {
  const root = await mkdtemp(join(tmpdir(), 'ligule-extensions-'));
  created.push(root);
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  return root;
}
after(() => Promise.all(created.map((root) => rm(root, { recursive: true, force: true }))));

test('sources come from the install directory, the user layer and the command line, not from the repository', async () => {
  const root = await directoryWith({ 'b.js': '', 'a.js': '', 'notes.txt': '' });
  const listed = await extensionSources(
    {
      user: { extensions: ['tools/deep.js'] },
      flag: { extensions: [] },
      project: { extensions: ['evil.js'] },
      local: { extensions: ['also-evil.js'] },
    },
    { projectRoot: root, userHome: root, readDirectory: () => Promise.resolve(['b.js', 'a.js', 'notes.txt']) },
  );
  const installedDirectory = join(root, '.ligule', 'extensions');
  assert.deepEqual(listed.paths, [join(installedDirectory, 'a.js'), join(installedDirectory, 'b.js'), join(root, 'tools', 'deep.js')].sort());
  assert.equal(listed.installedDirectory, installedDirectory);
  assert.deepEqual(listed.ignored.map((entry) => [entry.code, entry.path]), [['extension_source_ignored', 'project'], ['extension_source_ignored', 'local']]);
  // 安装目录不存在不是错误：一行都没装过是正常状态。
  const missing = await extensionSources({}, { projectRoot: root, userHome: join(root, 'nope'), readDirectory: () => Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' })) });
  assert.deepEqual(missing.paths, []);
});

test('the narrow interface is the four things the contract names, and registrations reach the kernel', async () => {
  const root = await directoryWith({
    'one.js': `export default function one(host) {
  host.registerTool({ name: 'extra', description: 'from the extension', parameters: { type: 'object', properties: {} }, run: async () => ({ text: 'ran' }) });
  host.registerPrompt({ name: 'notes', text: 'what the extension wants said' });
  globalThis.__seen = Object.keys(host).sort().join(',');
}`,
  });
  const kernel = createKernel({ config: createConfig({ user: { boundary: root } }) });
  const fragments = [];
  const loaded = await loadExtensions([join(root, 'one.js')], {
    config: {},
    registerTool: (tool) => kernel.register(tool),
    registerFragment: (fragment) => {
      fragments.push(fragment);
      return () => fragments.splice(fragments.indexOf(fragment), 1);
    },
    addEventListener: () => () => {},
    request: (name, args) => kernel.call(name, args),
  });
  assert.deepEqual(loaded.loaded.map((entry) => entry.name), ['one']);
  assert.equal(globalThis.__seen, 'onEvent,registerPrompt,registerTool,request');
  assert.deepEqual(kernel.list(), ['extra']);
  assert.equal(fragments[0].text, 'what the extension wants said');
  loaded.dispose();
  assert.deepEqual(kernel.list(), []);
  assert.deepEqual(fragments, []);
});

test('a broken extension takes back its own registrations and leaves the others alone', async () => {
  const root = await directoryWith({
    'good.js': 'export default function good(host) { host.registerTool({ name: "keep", description: "stays", parameters: { type: "object", properties: {} }, run: async () => ({ text: "ok" }) }); }',
    'no-default.js': 'export const notAFactory = 1;',
    'throws.js': 'export default function throws(host) { host.registerTool({ name: "half", description: "must not stay", parameters: { type: "object", properties: {} }, run: async () => ({ text: "ok" }) }); throw new Error("boom in setup"); }',
  });
  const kernel = createKernel({ config: createConfig({ user: { boundary: root } }) });
  const loaded = await loadExtensions(
    [join(root, 'good.js'), join(root, 'no-default.js'), join(root, 'throws.js')],
    {
      config: {},
      registerTool: (tool) => kernel.register(tool),
      registerFragment: () => () => {},
      addEventListener: () => () => {},
      request: (name, args) => kernel.call(name, args),
    },
  );
  assert.deepEqual(loaded.diagnostics.map((entry) => entry.code), ['extension_shape_invalid', 'extension_load_failed']);
  assert.match(loaded.diagnostics[1].detail, /boom in setup/);
  // 坏掉那件自己登记的半截被撤走，前一件好的留下：一次装载失败不留半装的表，也不带走别人。
  assert.deepEqual(kernel.list(), ['keep']);
});

test('what an extension asks for still passes the decision chain and the record', async () => {
  const root = await directoryWith({
    'calls.js': `export default function calls(host) {
  globalThis.__request = () => host.request('read', { path: '../outside.txt' });
}`,
  });
  const kernel = createKernel({ config: createConfig({ user: { boundary: root } }) });
  loadAssembly(kernel, [minimalPlugin]);
  const loaded = await loadExtensions([join(root, 'calls.js')], {
    config: {},
    registerTool: (tool) => kernel.register(tool),
    registerFragment: () => () => {},
    addEventListener: () => () => {},
    request: (name, args) => kernel.call(name, args),
  });
  loaded.dispose();
  await assert.rejects(
    () => globalThis.__request(),
    (error) => error.code === 'path_escapes_boundary',
    'the boundary is not something an extension can step around by asking',
  );
});

// 判据那一条：一份扩展装上一件工具与一段提示词片段，选它的模式看得见这两样；名字写错在装载那一刻就报。
const { createConnection, createMemoryConnectionPair, MESSAGES_CAPABILITIES, modeDirectories, serveHost } = await import('../dist/index.js');

async function withSession(modePrompt, run) {
  const root = await directoryWith({
    'one.js': 'export default function one(host) { host.registerTool({ name: "extra", description: "from the extension", parameters: { type: "object", properties: {} }, run: async () => ({ text: "ran" }) }); host.registerPrompt({ name: "notes", text: "what the extension wants said" }); }',
  });
  const userHome = join(root, 'home');
  const directories = modeDirectories(root, shippedModes, userHome);
  await mkdir(directories.user, { recursive: true });
  await writeFile(join(directories.user, 'picked.toml'), `tools = "*"\nprompt = ${JSON.stringify(modePrompt)}\n`);
  const config = createConfig({ user: { boundary: root, model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'm' }, policy: { mode: 'ask' } } });
  const requests = [];
  const provider = {
    capabilities: MESSAGES_CAPABILITIES,
    model: 'm',
    async *stream(request) {
      requests.push(request);
      yield { type: 'text', text: 'ok' };
    },
  };
  const pair = createMemoryConnectionPair();
  const host = serveHost({
    input: pair.host.input,
    output: pair.host.output,
    config,
    provider,
    policy: config.policy,
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
    const { sessionId } = await connection.request('session.create', {});
    await connection.request('run.start', { sessionId, input: 'say ok' });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].tools.map((entry) => entry.name).includes('extra'), 'the extension tool reaches the manifest');
    assert.match(JSON.stringify(requests[0].system ?? requests[0]), /what the extension wants said/);
  });
});

test('a mode naming a fragment nobody registered fails at the request, not silently', async () => {
  const failure = await withSession(['absent'], (connection) =>
    connection.request('session.create', {}).catch((error) => error));
  assert.equal(failure.code, 'mode_prompt_unavailable');
  assert.match(failure.detail, /absent/);
});
