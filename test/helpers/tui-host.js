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
// 靠画面决定下一步的写法还会把那一轮永远等下去。read 只在没等到时交出画面供报告用。
export async function waitFor(condition, { within = 10_000, every = 30, read = () => '' } = {}) {
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
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
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
    pair = createMemoryConnectionPair();
    const requests = [];
    const notifications = [];
    observeFrames(pair.host.input, (message) => {
      if (typeof message.method === 'string') requests.push({ method: message.method, params: message.params });
    });
    observeFrames(pair.client.input, (message) => {
      if (typeof message.notify === 'string') notifications.push(message);
    });
    host = serveHost({ ...pair.host, config, provider, policy: config.policy,
      modeName: 'minimal', modePaths: modeDirectories(projectDirectory, fileURLToPath(new URL('../../modes/', import.meta.url)), homeDirectory),
    });
    const client = createConnection(pair.client);
    const { sessionId } = await client.request('session.create', {});
    return await run({ client, config, directory, sessionDirectory, sessionId, requests, notifications, providerRequests, host, hostOutput: pair.host.output });
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
