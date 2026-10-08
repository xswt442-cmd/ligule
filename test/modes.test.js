// 第 22 步的验收（D35、D43、D44、D46）：模式文件的三层查找、两格的形状、错误码，
// 以及装载之后真的收紧了交给模型的那一栏工具。临时目录是真的目录层级，工具是真的最小清单，
// 提供方只用来把请求体交回来看见 tools 那一栏，没有假实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  applyMode, createConfig, createConnection, createKernel, createMemoryConnectionPair, createSkillPlugin, DEFAULT_MODE,
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
      // 模式不管技能与扩展的来源（D46）：写这一格就是写了一格没人读的东西，认不出来就报出去。
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

// prompt 这一格挑的是扩展登记进来的片段（D35 留下的那一格，第 29 步接上）：装载这一处只解析名字。
test('the prompt field keeps the names it was written with, selection happens at load', async () => {
  await withLayout(async ({ directories }) => {
    await writeMode(directories, 'user', 'review', 'tools = ["read"]\nprompt = ["notes"]\n');
    const mode = await loadMode('review', directories);
    assert.deepEqual(mode.prompt, ['notes']);
    // 哪一个名字在本次登记的片段里没有，要等扩展装完才知道，那一问由 Host 报 `mode_prompt_unavailable`。
    await writeMode(directories, 'user', 'wide', 'tools = ["read"]\nprompt = "*"\n');
    assert.equal((await loadMode('wide', directories)).prompt, '*');
  });
});

function kernelWithMinimal() {
  const kernel = createKernel({ config: createConfig({ user: { boundary: process.cwd() } }) });
  loadAssembly(kernel, [minimalPlugin]);
  return kernel;
}

// 固定披露入口（`skill`）不在这份名单里，所以模式既选不到它也藏不掉它（D63）。
function kernelWithDisclosure() {
  const kernel = createKernel({ config: createConfig({ user: { boundary: process.cwd() } }) });
  loadAssembly(kernel, [minimalPlugin, createSkillPlugin({ skills: [], diagnostics: [] })]);
  return kernel;
}

test('a mode cannot name the disclosure entry, and hiding the rest still leaves it visible', async () => {
  await withLayout(async ({ directories }) => {
    await writeMode(directories, 'user', 'withskill', complete('["read", "skill"]'));
    let error;
    try {
      applyMode(kernelWithDisclosure(), await loadMode('withskill', directories));
    } catch (failure) {
      error = failure;
    }
    // 写它的名字是清单写错了：静默收下会让人以为那一件被关掉了。
    assert.equal(error.code, 'mode_tool_not_selectable');
    assert.match(error.detail, /skill/);

    await writeMode(directories, 'user', 'justread', complete('["read"]'));
    const narrowed = kernelWithDisclosure();
    applyMode(narrowed, await loadMode('justread', directories));
    assert.deepEqual(narrowed.manifest().map((entry) => entry.name), ['read', 'skill']);
    assert.equal(narrowed.list().length, 9);
  });
});

test('applying a mode narrows what the model is offered, and "*" offers everything registered', async () => {
  await withLayout(async ({ directories, projectRoot, userHome }) => {
    await writeMode(directories, 'user', 'readonly', complete('["read", "find", "search"]'));
    const selected = applyMode(kernelWithMinimal(), await loadMode('readonly', directories)).tools;
    assert.deepEqual(selected, ['read', 'find', 'search']);

    const kernel = kernelWithMinimal();
    applyMode(kernel, await loadMode('readonly', directories));
    assert.deepEqual(kernel.manifest().map((entry) => entry.name), ['find', 'read', 'search']);
    // 登记表本身没被改动：被藏起来的三件仍然在，只是不再交给模型，也不允许被绕过去调用（I4）。
    assert.equal(kernel.list().length, MINIMAL.length);
    const shipped = modeDirectories(projectRoot, shippedModes, userHome);
    assert.deepEqual(applyMode(kernelWithMinimal(), await loadMode('full', shipped)).tools, MINIMAL);
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
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy, modeName: 'readonly', modePaths: directories });
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

// 第 25 步的验收（D41）：轮中不打断，本轮结束才换清单，生效之前再选一次当前那份就是撤回。
test('a switch asked for during a round takes effect only once that round ends', async () => {
  await withLayout(async ({ directories, projectRoot, userHome }) => {
    await writeMode(directories, 'user', 'readonly', complete('["read"]'));
    await writeMode(directories, 'user', 'wide', complete('["read", "find"]'));
    const config = createConfig({
      user: {
        boundary: projectRoot,
        model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
        policy: { mode: 'ask' },
      },
    });
    let release;
    const requests = [];
    const provider = {
      capabilities: MESSAGES_CAPABILITIES,
      model: 'test-model',
      async *stream(request) {
        requests.push(request);
        // 只卡第一次模型调用，让测试能站在「本轮还在跑」这一侧提请求；第二次照常走完。
        if (requests.length === 1) {
          await new Promise((resolve) => {
            release = resolve;
          });
        }
        yield { type: 'text', text: 'ok' };
      },
    };
    const pair = createMemoryConnectionPair();
    const host = serveHost({
      input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy,
      modeName: 'readonly', modePaths: directories,
    });
    const connection = createConnection(pair.client);
    const waiting = connection.request('session.create', {});
    try {
      const { sessionId } = await waiting;
      const running = connection.request('run.start', { sessionId, input: 'first' });
      // 等的是条件而不是「running 那一格刚落」：本轮真正卡在第一次模型请求上，那一次没到就没有 `release` 可按。
      for (let tried = 0; (await connection.request('status.get', { sessionId })).running !== true || requests.length === 0; tried += 1) {
        assert.ok(tried < 100, 'the round never started');
        await setTimeout(5);
      }

      const asked = await connection.request('mode.set', { sessionId, name: 'wide' });
      assert.equal(asked.pending, 'wide');
      assert.deepEqual(asked.tools, ['read'], '本轮交给模型的那一栏没在半路变');

      // 再选一次当前那一份：这是撤回，不是第二次切换。
      const withdrawn = await connection.request('mode.set', { sessionId, name: 'readonly' });
      assert.equal(withdrawn.pending, null);
      assert.equal(withdrawn.mode, 'readonly');

      await connection.request('mode.set', { sessionId, name: 'wide' });
      release();
      assert.equal((await running).text, 'ok');

      const after = await connection.request('status.get', { sessionId });
      assert.equal(after.mode, 'wide');
      assert.equal(after.pendingMode, null);
      assert.deepEqual(after.tools, ['find', 'read']);
      // 下一轮真的用上新清单（收紧撤掉后 find 又回来了）。
      await connection.request('run.start', { sessionId, input: 'second' });
      assert.deepEqual(requests[1].tools.map((entry) => entry.name), ['find', 'read']);
      const { events } = await connection.request('session.read', { sessionId });
      assert.deepEqual(events.filter((event) => event.kind === 'mode').map((event) => event.name), ['readonly', 'wide']);
    } finally {
      release?.();
      pair.client.output.end();
      host.release();
    }
  });
});
