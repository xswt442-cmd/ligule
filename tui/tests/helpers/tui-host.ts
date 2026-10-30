import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfig } from '../../../core/dist/kernel/config.js';
import type { ConfigSnapshot } from '../../../core/dist/kernel/config.js';
import { createPermissionContext, type PermissionContext } from '../../../core/dist/kernel/permission.js';
import { detectPermissionCapabilities } from '../../../core/dist/capability/permission-capabilities.js';
import { createConnection } from '../../../core/dist/host/connection.js';
import type { Connection } from '../../../core/dist/host/connection.js';
import { createMemoryConnectionPair } from '../../../core/dist/host/memory.js';
import type { MemoryConnectionPair } from '../../../core/dist/host/memory.js';
import { serveHost } from '../../../core/dist/host/host.js';
import type { Host } from '../../../core/dist/host/host.js';
import { providerFromConfig } from '../../../core/dist/host/provider.js';
import { modeDirectories } from '../../../core/dist/kernel/modes.js';
import { fileURLToPath } from 'node:url';
import { listenFetchable } from './port.ts';

type ChatRequestBody = {
  messages: { role: string; content?: unknown }[];
  tools: { function: { name: string } }[];
};

type ToolOperation = { tool?: string; args?: unknown };

type TestConfig = ConfigSnapshot & {
  boundary: string;
  host: { sessionDirectory: string };
  model: { api: 'chat-completions'; baseURL: string; model: string; apiKeyEnv: string };
  policy: { mode: 'ask' };
};

type TuiHostSetupPaths = {
  directory: string;
  projectDirectory: string;
  homeDirectory: string;
  sessionDirectory: string;
};

type TuiHostContext = Omit<TuiHostSetupPaths, 'homeDirectory'> & {
  client: Connection;
  config: TestConfig;
  sessionId: string;
  requests: { method: string; params: unknown }[];
  notifications: Record<string, unknown>[];
  providerRequests: ChatRequestBody[];
  host: Host;
  hostOutput: PassThrough;
};

type TuiHostOptions = {
  delayMs?: number;
  setup?: (paths: TuiHostSetupPaths) => void | Promise<void>;
  config?: Record<string, unknown>;
  interactive?: boolean;
  permissionControl?: boolean;
  permission?: PermissionContext;
};

export async function measuredPermissionContext(
  profile: PermissionContext['profile'],
  network: PermissionContext['network'],
): Promise<PermissionContext> {
  const snapshot = await detectPermissionCapabilities();
  return createPermissionContext(profile, network, snapshot.capabilities);
}

function observeFrames(stream: PassThrough, visit: (message: Record<string, unknown>) => void): void {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    let end = buffer.indexOf('\n');
    while (end >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line !== '') visit(JSON.parse(line) as Record<string, unknown>);
      end = buffer.indexOf('\n');
    }
  });
}

// 轮询条件直到成立或超时；超时时附上最近的终端输出，便于定位失败原因。
export async function waitFor(condition: () => boolean | Promise<boolean>, { within = 150_000, every = 30, read = () => '' }: {
  within?: number;
  every?: number;
  read?: () => string;
} = {}): Promise<void> {
  const deadline = Date.now() + within;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`等的条件没有成立\n${read().slice(-1_500)}`);
    await delay(every);
  }
}

export async function withTuiHost<TResult>(run: (context: TuiHostContext) => TResult | Promise<TResult>, {
  delayMs = 0,
  setup,
  config: extra = {},
  interactive = false,
  permissionControl = true,
  permission,
}: TuiHostOptions = {}): Promise<TResult> {
  const testplace = resolve('testplace');
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

  const envKeys = ['HOME', 'USERPROFILE', 'LIGULE_TUI_TEST_API_KEY'] as const;
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.HOME = homeDirectory;
  process.env.USERPROFILE = homeDirectory;
  process.env.LIGULE_TUI_TEST_API_KEY = 'test-key';

  const providerRequests: ChatRequestBody[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks);
      const body = JSON.parse(rawBody.toString('utf8')) as ChatRequestBody;
      providerRequests.push(body);
      const lastUser = [...body.messages].reverse().find((message) => message.role === 'user');
      if (typeof lastUser?.content !== 'string') throw new Error('tui_host_user_message_missing');
      let operation: ToolOperation | undefined;
      try { operation = JSON.parse(lastUser.content) as ToolOperation; } catch { /* 普通文本走回显服务。 */ }
      const result = body.messages.at(-1);
      const finalMessage = result!;
      const toolName = operation?.tool;
      const call = toolName !== undefined && finalMessage.role !== 'tool'
        && body.tools.some((tool) => tool.function.name === toolName);
      const answer = `Local response: ${finalMessage.role === 'tool' ? finalMessage.content : lastUser.content}`;
      if (delayMs > 0) await delay(delayMs);
      if (response.destroyed) return;
      const frames = [
        { choices: [{ index: 0, delta: call ? { tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: toolName, arguments: JSON.stringify(operation?.args) } }] } : { content: answer } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] },
        { choices: [], usage: { prompt_tokens: rawBody.byteLength, completion_tokens: Buffer.byteLength(answer) } },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end((error as Error).message);
    }
  });

  let host: Host | undefined;
  let pair: MemoryConnectionPair | undefined;
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
    } }) as TestConfig;
    const provider = providerFromConfig(config);
    const modesDirectory = fileURLToPath(new URL('../../../core/modes/', import.meta.url));
    // 为指定项目目录创建独立配置环境。
    const modelShape = { api: 'chat-completions', baseURL: baseUrl, model: 'local-test-model', apiKeyEnv: 'LIGULE_TUI_TEST_API_KEY' };
    const loadEnvironment = async (projectRoot: string) => {
      const sessions = join(projectRoot, 'sessions');
      await mkdir(sessions, { recursive: true });
      const other = createConfig({ user: {
        boundary: projectRoot,
        host: { sessionDirectory: sessions },
        model: modelShape,
        loop: { iterations: 2, modelCalls: 2 },
        limits: { contextTokens: 200000 },
        policy: { mode: 'ask' },
      } }) as TestConfig;
      return {
        config: other,
        provider: providerFromConfig(other),
        policy: other.policy,
        modeName: 'minimal',
        modePaths: modeDirectories(projectRoot, modesDirectory, homeDirectory),
      };
    };
    pair = createMemoryConnectionPair();
    const requests: TuiHostContext['requests'] = [];
    const notifications: TuiHostContext['notifications'] = [];
    observeFrames(pair.host.input, (message) => {
      if (typeof message.method === 'string') requests.push({ method: message.method, params: message.params });
    });
    observeFrames(pair.client.input, (message) => {
      if (typeof message.notify === 'string') notifications.push(message);
    });
    host = serveHost({ ...pair.host, config, provider, policy: config.policy, loadEnvironment,
      // 测试客户端可以响应模型发起的问题。
      interactive,
      ...(permission === undefined ? {} : { permission }),
      permissionControl,
      modeName: 'minimal', modePaths: modeDirectories(projectDirectory, modesDirectory, homeDirectory),
    });
    const client = createConnection(pair.client);
    const { sessionId } = await client.request('session.create', {}) as { sessionId: string };
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
          await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
        }
      }
    } finally {
      for (const key of envKeys) {
        if (previousEnv[key] === undefined) delete process.env[key];
        else process.env[key] = previousEnv[key];
      }
      // Host.release 已结束并释放 Session 锁；Windows 仍可能在短暂关闭句柄期间返回 EBUSY。
      // 仅对测试目录清理做有界文件系统重试，持续占用仍会让测试失败。
      await rm(absoluteDirectory, { recursive: true, force: true,
        ...(process.platform === 'win32' ? { maxRetries: 5, retryDelay: 100 } : {}) });
    }
  }
}
