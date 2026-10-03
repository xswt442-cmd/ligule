// 第 22 步的验收（D35、D43、D44、D49）：模式文件的三层查找、两格的形状、错误码，
// 以及装载之后真的收紧了交给模型的那一栏工具。临时目录是真的目录层级，工具是真的最小清单，
// 提供方只用来把请求体交回来看见 tools 那一栏，没有假实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  applyMode, createConfig, createConnection, createKernel, createMemoryConnectionPair, DEFAULT_MODE,
  loadAssembly, loadMode, MESSAGES_CAPABILITIES, minimalPlugin, modeDirectories, serveHost,
} from '../dist/index.js';

const shippedModes = fileURLToPath(new URL('../modes/', import.meta.url));
const MINIMAL = ['create', 'delete', 'edit', 'exec', 'find', 'read', 'search', 'write'];

// 三层目录各放在一个临时根下：userHome 与 projectRoot 指哪儿都由调用方给，不碰进程环境。
async function withLayout(run) {
  const root = await mkdtemp(join(tmpdir(), 'ligule-modes-'));
  const projectRoot = join(root, 'project');
  const userHome = join(root, 'home');
  await mkdir(join(userHome, '.ligule', 'modes'), { recursive: true });
  await mkdir(join(projectRoot, '.ligule', 'modes'), { recursive: true });
  try {
    return await run({ directories: modeDirectories(projectRoot, shippedModes, userHome), projectRoot, userHome });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeMode(directories, layer, name, text) {
  const path = join(directories[layer], `${name}.toml`);
  await mkdir(directories[layer], { recursive: true });
  await writeFile(path, text);
  return path;
}

const complete = (tools) => `tools = ${tools}\nprompt = []\n`;

test('the same name in two layers resolves to the highest one, whole file and no merging', async () => {
  await withLayout(async ({ directories }) => {
    await writeMode(directories, 'user', 'review', complete('["read", "find"]'));
    await writeMode(directories, 'project', 'review', complete('["read"]'));
    const mode = await loadMode('review', directories);
    assert.equal(mode.layer, 'project');
    assert.deepEqual(mode.tools, ['read']);
  });
});

test('a name only the shipped layer has still loads, and the default is the shipped minimal one', async () => {
  await withLayout(async ({ projectRoot, userHome }) => {
    const shipped = modeDirectories(projectRoot, shippedModes, userHome);
    const minimal = await loadMode(DEFAULT_MODE, shipped);
    assert.equal(minimal.layer, 'shipped');
    // 文件里写的顺序就是要交给模型的那一份顺序，装载不重排；这里比的是同一批成员。
    assert.deepEqual([...minimal.tools].sort(), MINIMAL);
    const full = await loadMode('full', shipped);
    assert.equal(full.tools, '*');
  });
});

test('a missing name says so and names the directories it looked in', async () => {
  await withLayout(async ({ directories }) => {
    const error = await loadMode('absent', directories).catch((failure) => failure);
    assert.equal(error.code, 'mode_unknown');
    assert.match(error.detail, /modes.absent\.toml/);
  });
});

test('a name that could escape the mode directories is refused before any read', async () => {
  await withLayout(async ({ directories }) => {
    for (const name of ['../secret', 'a/b', '', 'Upper', 'x'.repeat(200)]) {
      const error = await loadMode(name, directories).catch((failure) => failure);
      assert.equal(error.code, 'mode_name_invalid', name);
    }
  });
});

// 两格每一格都要写：写了名字却没生效的那一格，比少写一格更难查（I2）。
test('both fields are required and nothing else is accepted', async () => {
  await withLayout(async ({ directories }) => {
    const cases = [
      ['tools = ["read"]\n', 'mode_field_missing'],
      ['prompt = []\n', 'mode_field_missing'],
      [`${complete('["read"]')}extra = 1\n`, 'mode_field_unknown'],
      // 模式不管技能与扩展的来源（D49）：写这一格就是写了一格没人读的东西，认不出来就报出去。
      [`${complete('["read"]')}sources = ["./plugin.ts"]\n`, 'mode_field_unknown'],
      ['tools = "read"\nprompt = []\n', 'mode_field_invalid'],
      [complete('["read", "read"]'), 'mode_field_duplicate'],
      ['tools = { oops = 1 }\nprompt = []\n', 'mode_field_invalid'],
      ['not toml at all = =\n', 'mode_file_invalid'],
    ];
    for (const [index, [text, code]] of cases.entries()) {
      await writeMode(directories, 'user', `shape${index}`, text);
      const error = await loadMode(`shape${index}`, directories).catch((failure) => failure);
      assert.equal(error.code, code, `${code} expected for:\n${text}`);
    }
  });
});

test('the project layer wins whole, and its file still cannot name what the loader has no field for', async () => {
  await withLayout(async ({ directories }) => {
    await writeMode(directories, 'user', 'mine', complete('["read", "find"]'));
    await writeMode(directories, 'project', 'mine', complete('["read"]'));
    const mode = await loadMode('mine', directories);
    assert.equal(mode.layer, 'project');
    // 整份覆盖：全局那份写了两个工具，项目那份写一个，生效的就只有一个，不做按键合并。
    assert.deepEqual(mode.tools, ['read']);
  });
});

// prompt 这一格这一轮只解析校验：写了内容而装载还不接，当场失败而不是悄悄忽略（第 23 步把它接上）。
test('fields the loader does not act on yet refuse a non-empty value', async () => {
  await withLayout(async ({ directories }) => {
    await writeMode(directories, 'user', 'later', 'tools = ["read"]\nprompt = ["notes"]\n');
    const error = await loadMode('later', directories).catch((failure) => failure);
    assert.equal(error.code, 'mode_field_unsupported');
    assert.match(error.detail, /prompt/);
  });
});

function kernelWithMinimal() {
  const kernel = createKernel({ config: createConfig({ user: { boundary: process.cwd() } }) });
  loadAssembly(kernel, [minimalPlugin]);
  return kernel;
}

test('applying a mode narrows what the model is offered, and "*" offers everything registered', async () => {
  await withLayout(async ({ directories, projectRoot, userHome }) => {
    await writeMode(directories, 'user', 'readonly', complete('["read", "find", "search"]'));
    const selected = applyMode(kernelWithMinimal(), await loadMode('readonly', directories));
    assert.deepEqual(selected, ['read', 'find', 'search']);

    const kernel = kernelWithMinimal();
    applyMode(kernel, await loadMode('readonly', directories));
    assert.deepEqual(kernel.manifest().map((entry) => entry.name), ['find', 'read', 'search']);
    // 登记表本身没被改动：被藏起来的三件仍然在，只是不再交给模型，也不允许被绕过去调用（I4）。
    assert.equal(kernel.list().length, MINIMAL.length);
    const shipped = modeDirectories(projectRoot, shippedModes, userHome);
    assert.deepEqual(applyMode(kernelWithMinimal(), await loadMode('full', shipped)), MINIMAL);
  });
});

test('a mode naming a tool this run never registered fails instead of quietly offering fewer', async () => {
  await withLayout(async ({ directories }) => {
    await writeMode(directories, 'user', 'typo', complete('["read", "browser"]'));
    const mode = await loadMode('typo', directories);
    let error;
    try {
      applyMode(kernelWithMinimal(), mode);
    } catch (failure) {
      error = failure;
    }
    assert.equal(error.code, 'mode_tool_unregistered');
    assert.match(error.detail, /browser/);
    // 报错时把本次真的登记了哪几件一起说出来，写清单的人不用再去翻代码。
    assert.match(error.detail, /registered: create, delete/);
  });
});

// 装载真的走到交给模型的那一份请求里：Host 在一侧收紧，提供方请求体的 tools 就是那一栏。
test('a session built by the Host asks the provider with only the mode-selected tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-modes-host-'));
  const projectRoot = join(root, 'project');
  const userHome = join(root, 'home');
  await mkdir(join(userHome, '.ligule', 'modes'), { recursive: true });
  await writeFile(join(root, 'note.txt'), 'hello');
  const directories = modeDirectories(projectRoot, shippedModes, userHome);
  await writeMode(directories, 'user', 'readonly', complete('["read"]'));
  const mode = await loadMode('readonly', directories);
  const config = createConfig({
    user: {
      boundary: root,
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
      policy: { mode: 'ask' },
    },
  });
  const requests = [];
  const provider = {
    capabilities: MESSAGES_CAPABILITIES,
    model: 'test-model',
    async *stream(request) {
      requests.push(request);
      yield { type: 'message_start', message: { usage: {} } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_stop' };
    },
  };
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy, mode });
  const connection = createConnection(pair.client);
  try {
    const { sessionId } = await connection.request('session.create', {});
    await connection.request('run.start', { sessionId, input: 'say ok' });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].tools.map((entry) => entry.name), ['read']);
  } finally {
    pair.client.output.end();
    host.release();
    await rm(root, { recursive: true, force: true });
  }
});
