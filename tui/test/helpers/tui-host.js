import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfig } from '../../../core/dist/kernel/config.js';
import { createConnection } from '../../../core/dist/host/connection.js';
import { createMemoryConnectionPair } from '../../../core/dist/host/memory.js';
import { serveHost } from '../../../core/dist/host/host.js';
import { createChatCompletionsProvider } from '../../../core/dist/model/chat-completions.js';
import { modeDirectories } from '../../../core/dist/kernel/modes.js';
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

// 轮询条件直到成立或超时；超时时附上最近的终端输出，便于定位失败原因。
export async function waitFor(condition, { within = 150_000, every = 30, read = () => '' } = {}) {
  const deadline = Date.now() + within;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline) throw new Error(`等的条件没有成立\n${read().slice(-1_500)}`);
    await delay(every);
  }
}

export async function withTuiHost(run, { delayMs = 0, setup, config: extra = {}, interactive = false } = {}) {  const testplace = resolve('testplace');
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
        { choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] },
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
    const modesDirectory = fileURLToPath(new URL('../../../core/modes/', import.meta.url));
    // 为指定项目目录创建独立环境，并使用配置与 Provider 工厂各自要求的属性名。
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
      // 测试客户端可以响应模型发起的问题。
      interactive,
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
        // 关闭本地 HTTP 服务，确保测试结束后不遗留活动句柄。
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
