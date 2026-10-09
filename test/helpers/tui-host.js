import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfig } from '../../dist/kernel/config.js';
import { createConnection } from '../../dist/host/connection.js';
import { createMemoryConnectionPair } from '../../dist/host/memory.js';
import { serveHost } from '../../dist/host/host.js';
import { createChatCompletionsProvider } from '../../dist/model/chat-completions.js';
import { modeDirectories } from '../../dist/kernel/modes.js';
import { fileURLToPath } from 'node:url';
import { listenFetchable } from './port.js';

function observeFrames(stream, visit) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    let end = buffer.indexOf('\n');
    while (end >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line !== '') visit(JSON.parse(line));
      end = buffer.indexOf('\n');
    }
  });
}

// 等一个条件成立。固定毫秒的等待在负载高的机器上会先于渲染到期：检查会假红，
// 靠画面决定下一步的写法还会把那一轮永远等下去。几份终端界面的检查并行跑时，一条本机回环上的模型往返
// 能在 10 秒内落不下来（单独跑那一份时 1.6 秒就过），所以这一格留到 60 秒：成立就立刻返回，绿的运行不变慢。
// read 只在没等到时交出画面供报告用。
// 默认给到 150 秒：并发跑整份时一具假终端要跟十几份测试抢进程，等一帧画出来的墙钟不是单机那一档。
// 判据不变——条件不成立仍然当场失败（U52 那一条），只是把「慢」与「错」分开。
export async function waitFor(condition, { within = 150_000, every = 30, read = () => '' } = {}) {
  const deadline = Date.now() + within;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline) throw new Error(`等的条件没有成立\n${read().slice(-1_500)}`);
    await delay(every);
  }
}

export async function withTuiHost(run, { delayMs = 0, setup, config: extra = {} } = {}) {  const testplace = resolve('testplace');
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'tui-host-'));
  const absoluteDirectory = resolve(directory);
  if (!absoluteDirectory.startsWith(`${testplace}${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('tui_host_test_directory_invalid');
  }
  const homeDirectory = join(directory, 'home');
  const projectDirectory = join(directory, 'project');
  const sessionDirectory = join(directory, 'sessions');
  await Promise.all([mkdir(homeDirectory), mkdir(projectDirectory)]);
  await setup?.({ directory, projectDirectory, homeDirectory, sessionDirectory });

  const envKeys = ['HOME', 'USERPROFILE', 'LIGULE_TUI_TEST_API_KEY'];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.HOME = homeDirectory;
  process.env.USERPROFILE = homeDirectory;
  process.env.LIGULE_TUI_TEST_API_KEY = 'test-key';

  const providerRequests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks);
      const body = JSON.parse(rawBody.toString('utf8'));
      providerRequests.push(body);
      const lastUser = [...body.messages].reverse().find((message) => message.role === 'user');
      if (typeof lastUser?.content !== 'string') throw new Error('tui_host_user_message_missing');
      let operation;
      try { operation = JSON.parse(lastUser.content); } catch { /* 普通文本走回显服务。 */ }
      const result = body.messages.at(-1);
      const call = operation?.tool !== undefined && result.role !== 'tool'
        && body.tools.some((tool) => tool.function.name === operation.tool);
      const answer = `Local response: ${result.role === 'tool' ? result.content : lastUser.content}`;
      if (delayMs > 0) await delay(delayMs);
      if (response.destroyed) return;
      const frames = [
        { choices: [{ index: 0, delta: call ? { tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: operation.tool, arguments: JSON.stringify(operation.args) } }] } : { content: answer } }] },
        { choices: [], usage: { prompt_tokens: rawBody.byteLength, completion_tokens: Buffer.byteLength(answer) } },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error.message);
    }
  });

  let host;
  let pair;
  try {
    const baseUrl = `http://127.0.0.1:${await listenFetchable(server)}/v1`;
    const config = createConfig({ user: {
      boundary: projectDirectory,
      host: { sessionDirectory },
      model: { api: 'chat-completions', baseURL: baseUrl, model: 'local-test-model', apiKeyEnv: 'LIGULE_TUI_TEST_API_KEY' },
      loop: { iterations: 2, modelCalls: 2 },
      limits: { contextTokens: 200000 },
      policy: { mode: 'ask' },
      ...extra,
    } });
    const provider = createChatCompletionsProvider({ baseUrl, model: 'local-test-model', apiKeyEnv: 'LIGULE_TUI_TEST_API_KEY' });
    const modesDirectory = fileURLToPath(new URL('../../modes/', import.meta.url));
    // 一具宿主接第二项目录时走这一条路（方案 3.2）：按指名的那一份根重算一份环境，其余格子与默认那一份同源。
    // 配置那一格拼写是 `baseURL`，提供方工厂要的是 `baseUrl`：两边各按各的名字给，不混用。
    const modelShape = { api: 'chat-completions', baseURL: baseUrl, model: 'local-test-model', apiKeyEnv: 'LIGULE_TUI_TEST_API_KEY' };
    const providerShape = { baseUrl, model: 'local-test-model', apiKeyEnv: 'LIGULE_TUI_TEST_API_KEY' };
    const loadEnvironment = async (projectRoot) => {
      const sessions = join(projectRoot, 'sessions');
      await mkdir(sessions, { recursive: true });
      const other = createConfig({ user: {
        boundary: projectRoot,
        host: { sessionDirectory: sessions },
        model: modelShape,
        loop: { iterations: 2, modelCalls: 2 },
        limits: { contextTokens: 200000 },
        policy: { mode: 'ask' },
      } });
      return {
        config: other,
        provider: createChatCompletionsProvider(providerShape),
        policy: other.policy,
        modeName: 'minimal',
        modePaths: modeDirectories(projectRoot, modesDirectory, homeDirectory),
      };
    };
    pair = createMemoryConnectionPair();
    const requests = [];
    const notifications = [];
    observeFrames(pair.host.input, (message) => {
      if (typeof message.method === 'string') requests.push({ method: message.method, params: message.params });
    });
    observeFrames(pair.client.input, (message) => {
      if (typeof message.notify === 'string') notifications.push(message);
    });
    host = serveHost({ ...pair.host, config, provider, policy: config.policy, loadEnvironment,
      modeName: 'minimal', modePaths: modeDirectories(projectDirectory, modesDirectory, homeDirectory),
    });
    const client = createConnection(pair.client);
    const { sessionId } = await client.request('session.create', {});
    return await run({ client, config, directory, projectDirectory, sessionDirectory, sessionId, requests, notifications, providerRequests, host, hostOutput: pair.host.output });
  } finally {
    try {
      try {
        if (pair !== undefined) pair.client.output.end();
        if (host !== undefined) await host.release();
      } finally {
        // 那台 HTTP 服务一定要关掉：它开着的时候整个测试进程退不出去，收尾失败报出来的就只剩一个挂住。
        if (server.listening) {
          server.closeAllConnections();
          await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
        }
      }
    } finally {
      for (const key of envKeys) {
        if (previousEnv[key] === undefined) delete process.env[key];
        else process.env[key] = previousEnv[key];
      }
      await rm(absoluteDirectory, { recursive: true, force: true });
    }
  }
}
