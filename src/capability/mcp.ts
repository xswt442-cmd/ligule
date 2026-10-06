// MCP 的接入（D52、D60，实现顺序第 30 步）：只接 stdio 一种传输，协议层用官方 SDK，不自己写 JSON-RPC。
//
// 配置形状是 `mcp.servers.<名字>` 一条 `command` 加可选的 `args`、`env`、`cwd`。`command` 是一个可执行文件，
// 不交给 shell（与 D59 同一条理由：一条字符串里能藏管道，判定链就看不见真正跑的是什么）。
// `env` 的值只允许 `${NAME}` 这一种写法，从进程环境里取；配置里不许写明文凭据（D13）。
//
// 模型侧只有两件固定工具（`mcp.inspect`、`mcp.call`，都是披露入口，不在模式的选择范围里，D63 同理）：
// 服务器各自的几十件工具不进模型可见清单，工具表因此不随连接涨（D52）。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { KernelError } from '../kernel/error.js';

export interface McpServerConfig {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
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

async function refreshTools(opened: ConnectedServer, signal?: AbortSignal): Promise<Map<string, ToolDefinition>> {
  const listed = await opened.client.listTools(undefined, signal === undefined ? undefined : { signal });
  opened.tools = new Map<string, ToolDefinition>();
  for (const raw of listed.tools as unknown as Record<string, unknown>[]) {
    const definition = definitionOf(raw);
    opened.tools.set(definition.name, definition);
  }
  return opened.tools;
}

// `${NAME}` 是唯一允许的取值形式：整串就是这一个引用，不做「一整条命令的展开」那种形式（D60 的未定在这一处定死）。
const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function expandEnv(env: Record<string, unknown>, environment: NodeJS.ProcessEnv): Record<string, string> {
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') throw new KernelError('mcp_env_unsupported', { detail: `${key} must be a "\${NAME}" reference` });
    const matched = ENV_REFERENCE.exec(value);
    if (matched === null) throw new KernelError('mcp_env_unsupported', { detail: `${key}="${value}" is not a \${NAME} reference` });
    const taken = environment[matched[1]];
    // 没有那一个变量就当它没设：把字面量 `${NAME}` 传下去会让服务器拿到一个看起来像凭据的字符串（D13）。
    if (taken !== undefined) expanded[key] = taken;
  }
  return expanded;
}

function definitionOf(raw: { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: unknown }): ToolDefinition {
  if (typeof raw.name !== 'string' || raw.name === '') throw new KernelError('mcp_tool_name_missing');
  const schema = (raw.inputSchema ?? { type: 'object' }) as Record<string, unknown>;
  // 摘要算的是「模型看见的那一份定义」：名字、说明、参数形状与标注，服务器改了任何一处都会换。
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

// 一条 MCP 工具声明的参数按声明校验（D14 的精神），用的是最小一份 JSON Schema 子集：
// 对象、必填、类型三种，数组与嵌套按声明递归下去；认不出的构造按「校验不了」报出去而不是放行。
function checkAgainstSchema(value: unknown, schema: Record<string, unknown>, at: string, problems: string[]): void {
  const type = schema.type;
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`${at} must be an object`);
      return;
    }
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const name of (schema.required ?? []) as string[]) {
      if ((value as Record<string, unknown>)[name] === undefined) problems.push(`${at}.${name} is required`);
    }
    for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
      const declared = properties[name];
      if (declared === undefined) {
        if (schema.additionalProperties === false) problems.push(`${at}.${name} is not declared by the tool`);
        continue;
      }
      checkAgainstSchema(item, declared, `${at}.${name}`, problems);
    }
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) { problems.push(`${at} must be an array`); return; }
    const items = schema.items as Record<string, unknown> | undefined;
    if (items !== undefined) value.forEach((item, index) => checkAgainstSchema(item, items, `${at}[${index}]`, problems));
    return;
  }
  if (type === undefined) return;
  const kinds: Record<string, () => boolean> = {
    string: () => typeof value === 'string',
    number: () => typeof value === 'number',
    integer: () => Number.isInteger(value),
    boolean: () => typeof value === 'boolean',
    null: () => value === null,
  };
  const isType = kinds[String(type)];
  if (isType === undefined) problems.push(`${at} declares a type this checker does not know (${String(type)})`);
  else if (!isType()) problems.push(`${at} must be ${type}`);
}

export function validateToolArguments(args: unknown, schema: Record<string, unknown>): string[] {
  const problems: string[] = [];
  checkAgainstSchema(args, { type: 'object', ...schema }, 'arguments', problems);
  return problems;
}

// 一份 MCP 配置折成要连的服务器列表：名字来自配置里的键，顺序按名字排，这样同一份文件两次装载得到同一张表。
export function mcpServerConfigs(config: { mcp?: { servers?: unknown } }, environment: NodeJS.ProcessEnv = process.env) {
  const servers = (config.mcp?.servers ?? {}) as Record<string, McpServerConfig>;
  return Object.keys(servers).sort().map((name) => {
    const entry = servers[name];
    if (typeof entry?.command !== 'string' || entry.command === '') throw new KernelError('mcp_command_required', { detail: `${name} needs a command` });
    // 一条可以执行的文件，不是一行交给 shell 的文本（D60 与 D59 同一条理由）：带空白的这一串里能藏参数与管道。
    if (/\s/.test(entry.command) && !existsSync(entry.command)) throw new KernelError('mcp_command_invalid', { detail: `${name}.command is a single executable; put its arguments in args` });
    const args = entry.args === undefined ? [] : entry.args;
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) throw new KernelError('mcp_args_invalid', { detail: `${name}.args must be an array of strings` });
    const env = entry.env === undefined ? {} : entry.env;
    if (env === null || typeof env !== 'object' || Array.isArray(env)) throw new KernelError('mcp_env_invalid', { detail: `${name}.env must be a table of \${NAME} references` });
    if (entry.cwd !== undefined && typeof entry.cwd !== 'string') throw new KernelError('mcp_cwd_invalid', { detail: name });
    return { name, command: entry.command, args: args as string[], env: expandEnv(env as Record<string, unknown>, environment), cwd: entry.cwd as string | undefined };
  });
}

function killServerProcess(pid: number): void {
  try {
    if (process.platform === 'win32') spawn('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // 已经退出的进程不需要第二次招呼。
  }
}

async function closeClient(client: Client): Promise<void> {
  const pid = (client.transport as unknown as { _process?: { pid?: number } })?._process?.pid;
  await client.close().catch(() => undefined);
  if (pid !== undefined) killServerProcess(pid);
}

// 连上去、读完定义之后留在进程里：一台服务器一条子进程，第一版不重连也不并发起多份。
export async function connectServer(settings: ReturnType<typeof mcpServerConfigs>[number], signal?: AbortSignal): Promise<ConnectedServer> {
  const transport = new StdioClientTransport({
    command: settings.command,
    args: settings.args,
    cwd: settings.cwd,
    env: { ...process.env, ...settings.env } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ligule', version: '0.0.1' });
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
  close(): Promise<void>;
}

// 注册表按名字惰性连接：没被用到的服务器不起子进程，一条 `ligule tools` 也不该带走十个进程。
export function createMcpRegistry(configs: ReturnType<typeof mcpServerConfigs>): McpRegistry {
  const connected = new Map<string, ConnectedServer>();
  const pending = new Map<string, Promise<ConnectedServer>>();
  const lifetime = new AbortController();
  const closedClients = new WeakSet<Client>();
  let closing: Promise<void> | undefined;

  function operationSignal(signal?: AbortSignal): AbortSignal {
    return signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, signal]);
  }

  async function closeServer(opened: ConnectedServer): Promise<void> {
    if (closedClients.has(opened.client)) return;
    closedClients.add(opened.client);
    await closeClient(opened.client);
  }

  async function server(name: string, signal?: AbortSignal): Promise<ConnectedServer> {
    const activeSignal = operationSignal(signal);
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
    // 每一次问定义都重新列一次工具：服务器悄悄改了声明，只有再列一次才看得见（D52 的摘要那条要用到这一点）。
    toolsOf: async (name, signal) => [...(await refreshTools(await server(name, signal), operationSignal(signal))).values()],
    definition: async (name, tool, signal) => {
      const activeSignal = operationSignal(signal);
      const opened = await server(name, activeSignal);
      await refreshTools(opened, activeSignal);
      const found = opened.tools.get(tool);
      if (found === undefined) throw new KernelError('mcp_tool_unknown', { detail: `${name}/${tool}` });
      return found;
    },
    call: async (name, tool, args, signal) => {
      const activeSignal = operationSignal(signal);
      const opened = await server(name, activeSignal);
      if (!opened.tools.has(tool)) throw new KernelError('mcp_tool_unknown', { detail: `${name}/${tool}` });
      return opened.client.callTool({ name: tool, arguments: args as Record<string, unknown> }, undefined, { signal: activeSignal });
    },
    // 关子进程的顺序照 pi 记下的那一条：先关 stdin 再 SIGTERM，最后才带走整棵子树（D60 的来源）。
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
      })();
      return closing;
    },
  };
}
