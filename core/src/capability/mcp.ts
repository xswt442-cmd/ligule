// MCP 仅支持 stdio 传输，协议实现使用官方 SDK。
//
// `mcp.servers.<name>` 配置包含可执行文件 `command`，以及可选的 `args`、`env` 和 `cwd`。
// `command` 作为可执行文件直接启动，不经过 shell。`env` 只支持 `${NAME}` 环境变量引用，不接受明文凭据。
//
// 模型只看到固定的 `mcp.inspect` 和 `mcp.call` 工具；服务器自身的工具定义按需披露，不会扩大基础工具清单。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import { KernelError } from '../kernel/error.js';

export interface McpServerConfig {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
}

export interface NormalizedMcpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly environmentNames: readonly string[];
  readonly identityDigest: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  digest: string;
  annotations: Record<string, unknown>;
}

interface ConnectedServer {
  name: string;
  client: Client;
  tools: Map<string, ToolDefinition>;
}

const MCP_RUNTIME_ENVIRONMENT = new Set([
  'appdata', 'ci', 'comspec', 'force_color', 'home', 'homedrive', 'homepath', 'lang', 'lc_all',
  'localappdata', 'no_color', 'path', 'pathext', 'systemdrive', 'systemroot', 'term', 'tmp',
  'temp', 'tmpdir', 'userprofile', 'windir',
]);

function mcpEnvironment(referenced: Readonly<Record<string, string>>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && MCP_RUNTIME_ENVIRONMENT.has(name.toLowerCase())) environment[name] = value;
  }
  return { ...environment, ...referenced };
}

async function refreshTools(opened: ConnectedServer, signal?: AbortSignal): Promise<Map<string, ToolDefinition>> {
  const listed = await opened.client.listTools(undefined, signal === undefined ? undefined : { signal });
  opened.tools = new Map<string, ToolDefinition>();
  for (const raw of listed.tools as unknown as Record<string, unknown>[]) {
    const definition = definitionOf(raw);
    opened.tools.set(definition.name, definition);
  }
  return opened.tools;
}

// 环境值必须完整匹配 `${NAME}`；不支持在普通字符串中插值。
const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function expandEnv(env: Record<string, unknown>, environment: NodeJS.ProcessEnv): Record<string, string> {
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') throw new KernelError('mcp_env_unsupported', { detail: `${key} must be a "\${NAME}" reference` });
    const matched = ENV_REFERENCE.exec(value);
    if (matched === null) throw new KernelError('mcp_env_unsupported', { detail: `${key}="${value}" is not a \${NAME} reference` });
    const taken = environment[matched[1]];
    // 环境变量未设置时省略该项，不把 `${NAME}` 字面字符串传给服务器。
    if (taken !== undefined) expanded[key] = taken;
  }
  return expanded;
}

function definitionOf(raw: { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: unknown }): ToolDefinition {
  if (typeof raw.name !== 'string' || raw.name === '') throw new KernelError('mcp_tool_name_missing');
  const schema = (raw.inputSchema ?? { type: 'object' }) as Record<string, unknown>;
  // 摘要覆盖模型可见的名称、说明、参数结构和标注；这些定义任一变化都会改变摘要。
  const digest = createHash('sha256').update(JSON.stringify({
    name: raw.name,
    description: raw.description ?? '',
    inputSchema: schema,
    annotations: raw.annotations ?? {},
  })).digest('hex').slice(0, 12);
  return {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    inputSchema: schema,
    digest,
    annotations: (raw.annotations ?? {}) as Record<string, unknown>,
  };
}

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const DRAFT_7 = 'http://json-schema.org/draft-07/schema#';

export function validateToolArguments(args: unknown, schema: Record<string, unknown>): string[] {
  try {
    const declaredDialect = schema.$schema;
    const options = {
      allErrors: true,
      strictSchema: true,
      strictTypes: false,
      strictTuples: false,
      validateFormats: true,
      validateSchema: true,
    };
    const ajv = declaredDialect === undefined || declaredDialect === DRAFT_2020_12
      ? new Ajv2020(options)
      : declaredDialect === DRAFT_7
        ? new Ajv(options)
        : undefined;
    if (ajv === undefined) return [`tool schema dialect is unsupported: ${String(declaredDialect)}`];
    formatsModule.default.default(ajv as Ajv);
    const validator = new AjvJsonSchemaValidator(ajv as Ajv);
    const validate = validator.getValidator<Record<string, unknown>>({ type: 'object', ...schema } as JsonSchemaType);
    const result = validate(args);
    return result.valid ? [] : [result.errorMessage ?? 'arguments do not match the tool schema'];
  } catch (error) {
    return [`tool schema cannot be validated: ${error instanceof Error ? error.message : String(error)}`];
  }
}

// 将 MCP 配置转换为按名称排序的服务器列表，保证重复加载结果顺序稳定。
export function mcpServerConfigs(
  config: { mcp?: { servers?: unknown } },
  environment: NodeJS.ProcessEnv = process.env,
  projectRoot = process.cwd(),
): NormalizedMcpServerConfig[] {
  const servers = (config.mcp?.servers ?? {}) as Record<string, McpServerConfig>;
  return Object.keys(servers).sort().map((name) => {
    const entry = servers[name];
    if (typeof entry?.command !== 'string' || entry.command === '') throw new KernelError('mcp_command_required', { detail: `${name} needs a command` });
    if (entry.cwd !== undefined && typeof entry.cwd !== 'string') throw new KernelError('mcp_cwd_invalid', { detail: name });
    const cwd = entry.cwd === undefined ? resolve(projectRoot) : resolve(projectRoot, entry.cwd);
    const command = entry.command.includes('/') || entry.command.includes('\\') || isAbsolute(entry.command)
      ? resolve(cwd, entry.command)
      : entry.command;
    // `command` 必须是可执行文件路径，不能包含参数或 shell 管道。
    if (/\s/.test(entry.command) && !existsSync(command)) throw new KernelError('mcp_command_invalid', { detail: `${name}.command is a single executable; put its arguments in args` });
    const args = entry.args === undefined ? [] : entry.args;
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) throw new KernelError('mcp_args_invalid', { detail: `${name}.args must be an array of strings` });
    const env = entry.env === undefined ? {} : entry.env;
    if (env === null || typeof env !== 'object' || Array.isArray(env)) throw new KernelError('mcp_env_invalid', { detail: `${name}.env must be a table of \${NAME} references` });
    const references = env as Record<string, unknown>;
    const environmentNames = Object.keys(references).sort();
    const identityDigest = createHash('sha256').update(JSON.stringify({
      name,
      command,
      args,
      cwd: entry.cwd === undefined ? '<project-root>' : cwd,
      env: environmentNames.map((key) => [key, references[key]]),
      ...(command === entry.command ? { path: environment.PATH ?? '' } : {}),
    })).digest('hex');
    return {
      name,
      command,
      args: args as string[],
      env: expandEnv(references, environment),
      cwd,
      environmentNames,
      identityDigest,
    };
  });
}

function killServerProcess(pid: number): void {
  try {
    if (process.platform === 'win32') spawn('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // 已退出的子进程无需再次发送关闭信号。
  }
}

async function closeClient(client: Client): Promise<void> {
  const pid = (client.transport as unknown as { _process?: { pid?: number } })?._process?.pid;
  await client.close().catch(() => undefined);
  if (pid !== undefined) killServerProcess(pid);
}

// 每台服务器最多启动一个子进程，并在 Host 生命周期内复用；不自动重连或并发启动多个进程。
export async function connectServer(settings: NormalizedMcpServerConfig, signal?: AbortSignal): Promise<ConnectedServer> {
  const transport = new StdioClientTransport({
    command: settings.command,
    args: settings.args,
    cwd: settings.cwd,
    env: mcpEnvironment(settings.env),
    stderr: 'pipe',
  });
  // 这是 MCP 客户端协议身份，不代表 Core 有独立版本。
  const client = new Client({ name: 'ligule', version: '1.0.0' });
  try {
    await client.connect(transport, signal === undefined ? undefined : { signal });
    const opened = { name: settings.name, client, tools: new Map<string, ToolDefinition>() };
    await refreshTools(opened, signal);
    return opened;
  } catch (error) {
    await closeClient(client);
    throw new KernelError('mcp_connect_failed', { cause: error, detail: `${settings.name}: ${error instanceof Error ? error.message : String(error)}` });
  }
}

export interface McpRegistry {
  servers(): string[];
  toolsOf(server: string, signal?: AbortSignal): Promise<ToolDefinition[]>;
  definition(server: string, tool: string, signal?: AbortSignal): Promise<ToolDefinition>;
  call(server: string, tool: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  revoke(server: string): Promise<void>;
  close(): Promise<void>;
}

// 服务器按需连接；未使用的服务器不会启动子进程。
export function createMcpRegistry(configs: NormalizedMcpServerConfig[]): McpRegistry {
  const connected = new Map<string, ConnectedServer>();
  const pending = new Map<string, Promise<ConnectedServer>>();
  const serverLifetimes = new Map<string, AbortController>();
  const stopping = new Map<string, Promise<void>>();
  const lifetime = new AbortController();
  const closedClients = new WeakSet<Client>();
  let closing: Promise<void> | undefined;

  function operationSignal(name: string, signal?: AbortSignal): AbortSignal {
    let serverLifetime = serverLifetimes.get(name);
    if (serverLifetime === undefined) {
      serverLifetime = new AbortController();
      serverLifetimes.set(name, serverLifetime);
    }
    return signal === undefined
      ? AbortSignal.any([lifetime.signal, serverLifetime.signal])
      : AbortSignal.any([lifetime.signal, serverLifetime.signal, signal]);
  }

  async function closeServer(opened: ConnectedServer): Promise<void> {
    if (closedClients.has(opened.client)) return;
    closedClients.add(opened.client);
    await closeClient(opened.client);
  }

  async function server(name: string, signal?: AbortSignal): Promise<ConnectedServer> {
    await stopping.get(name);
    const activeSignal = operationSignal(name, signal);
    if (activeSignal.aborted) throw activeSignal.reason;
    const existing = connected.get(name);
    if (existing !== undefined) return existing;
    const settings = configs.find((entry) => entry.name === name);
    if (settings === undefined) throw new KernelError('mcp_server_unknown', { detail: `${name} (configured: ${configs.map((entry) => entry.name).join(', ') || 'none'})` });
    const started = pending.get(name) ?? connectServer(settings, activeSignal);
    pending.set(name, started);
    try {
      const opened = await started;
      if (activeSignal.aborted) {
        await closeServer(opened);
        throw activeSignal.reason;
      }
      connected.set(name, opened);
      return opened;
    } finally {
      if (pending.get(name) === started) pending.delete(name);
    }
  }

  return {
    servers: () => configs.map((entry) => entry.name),
    // 每次读取定义时重新获取工具列表，以检测服务器声明是否变化并更新摘要。
    toolsOf: async (name, signal) => [...(await refreshTools(await server(name, signal), operationSignal(name, signal))).values()],
    definition: async (name, tool, signal) => {
      const activeSignal = operationSignal(name, signal);
      const opened = await server(name, activeSignal);
      await refreshTools(opened, activeSignal);
      const found = opened.tools.get(tool);
      if (found === undefined) throw new KernelError('mcp_tool_unknown', { detail: `${name}/${tool}` });
      return found;
    },
    call: async (name, tool, args, signal) => {
      const activeSignal = operationSignal(name, signal);
      const opened = await server(name, activeSignal);
      if (!opened.tools.has(tool)) throw new KernelError('mcp_tool_unknown', { detail: `${name}/${tool}` });
      return opened.client.callTool({ name: tool, arguments: args as Record<string, unknown> }, undefined, { signal: activeSignal });
    },
    revoke: (name) => {
      const alreadyStopping = stopping.get(name);
      if (alreadyStopping !== undefined) return alreadyStopping;
      const controller = serverLifetimes.get(name);
      controller?.abort(new KernelError('mcp_server_untrusted', { detail: name }));
      const closing = (async () => {
        const inflight = pending.get(name);
        if (inflight !== undefined) await inflight.catch(() => undefined);
        const opened = connected.get(name);
        if (opened !== undefined) await closeServer(opened);
        connected.delete(name);
        pending.delete(name);
        serverLifetimes.delete(name);
      })();
      stopping.set(name, closing);
      return closing.finally(() => {
        if (stopping.get(name) === closing) stopping.delete(name);
      });
    },
    // 先关闭 stdin，再发送 SIGTERM，最后终止仍存活的子进程树。
    close: () => {
      if (closing !== undefined) return closing;
      lifetime.abort(new Error('MCP registry closed'));
      closing = (async () => {
        const settled = await Promise.allSettled([...pending.values()]);
        const opened = new Set(connected.values());
        for (const result of settled) if (result.status === 'fulfilled') opened.add(result.value);
        await Promise.all([...opened].map(closeServer));
        connected.clear();
        pending.clear();
        serverLifetimes.clear();
      })();
      return closing;
    },
  };
}
