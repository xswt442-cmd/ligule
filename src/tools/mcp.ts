// `mcp.inspect` 与 `mcp.call` 两件固定工具（D52、D60，实现顺序第 30 步）。
//
// 模型长期只看到这两件：服务器各自的工具要先用 `inspect` 看清楚定义与摘要，才能被 `call` 调用。
// 两件都是披露入口，因此不在模式的选择范围里（与 `skill` 同一格规则，D63）。
//
// `call` 的参数里 `arguments` 是一段 JSON 文本而不是对象：内核认下来的参数模式子集（D14）没有「任意形状的嵌套对象」
// 这一构造，而 MCP 声明的输入形状本来就是任意的——把校验放到 Host 这一侧按声明做，模型可见的模式才不随连接变化（D52）。
import { KernelError } from '../kernel/error.js';
import type { McpRegistry, ToolDefinition } from '../capability/mcp.js';
import { validateToolArguments } from '../capability/mcp.js';

const LEVELS = 'without a server it lists the configured servers; with a server it lists that server\'s tools and their digests; with both it returns the full definition.';

export interface McpDisclosed {
  seen: Set<string>;
}

function key(server: string, tool: string, digest: string) {
  return `${server}/${tool}@${digest}`;
}

export function createMcpTools(registry: Pick<McpRegistry, 'servers' | 'toolsOf' | 'definition' | 'call'>, disclosed: McpDisclosed) {
  return {
    inspectTool: {
      name: 'mcp.inspect',
      disclosure: true,
      description: `Look up what an MCP server offers, one level at a time. ${LEVELS}`,
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'The configured server to look inside.' },
          tool: { type: 'string', description: 'One tool of that server, to get its full definition.' },
        },
        required: [],
      },
      async run(args: { server?: string; tool?: string }) {
        if (args.server === undefined) return { text: registry.servers().join('\n') || 'no MCP servers are configured' };
        const tools = await registry.toolsOf(args.server);
        if (args.tool === undefined) {
          return {
            text: (tools as ToolDefinition[]).map((tool) => `${tool.name}\t${tool.digest}\t${tool.description.split('\n')[0]}`).join('\n'),
            server: args.server,
            tools: (tools as ToolDefinition[]).map((tool) => ({ name: tool.name, digest: tool.digest })),
          };
        }
        const found = await registry.definition(args.server, args.tool);
        // 披露状态记在这里：模型看见的那一份定义与它的摘要，之后 `call` 要对着它问。
        disclosed.seen.add(key(args.server, args.tool, found.digest));
        return {
          text: JSON.stringify({ name: found.name, description: found.description, inputSchema: found.inputSchema, annotations: found.annotations, schemaDigest: found.digest }, null, 2),
          server: args.server,
          tool: found.name,
          schemaDigest: found.digest,
        };
      },
    },
    callTool: {
      name: 'mcp.call',
      disclosure: true,
      description: 'Call one MCP tool whose definition you have inspected. Pass its arguments as a JSON object text.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'The configured server.' },
          tool: { type: 'string', description: 'The tool to call.' },
          arguments: { type: 'string', description: 'A JSON object text matching the tool\'s declared input schema.' },
          schemaDigest: { type: 'string', description: 'The digest of the definition you inspected.' },
        },
        required: ['server', 'tool', 'arguments', 'schemaDigest'],
      },
      // 这一次调用真正用的能力是 `mcp:<服务器>/<工具>`，不是 `mcp.call` 这个名字（D52）：
      // 读一个文件与删一份数据不该退化成同一种操作，判定链要看见那两者的差别。
      capability: (args: { server?: string; tool?: string }) => `mcp:${args.server}/${args.tool}`,
      async run(args: { server: string; tool: string; arguments: string; schemaDigest: string }) {
        const found = await registry.definition(args.server, args.tool);
        // 看过的那一版与服务器现在的这一版是两件事：先问有没有看过，再问看的是不是旧的一版（D52）。
        if (!disclosed.seen.has(key(args.server, args.tool, args.schemaDigest))) {
          throw new KernelError('mcp_not_disclosed', {
            detail: `run mcp.inspect on ${args.server} ${args.tool} and read its definition before calling it`,
          });
        }
        if (args.schemaDigest !== found.digest) {
          throw new KernelError('mcp_definition_stale', {
            detail: `${args.server}/${args.tool} is now at ${found.digest}; the digest you read is ${args.schemaDigest}. Inspect it again before calling`,
          });
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(args.arguments);
        } catch (error) {
          throw new KernelError('mcp_arguments_invalid_json', { detail: `arguments is not JSON: ${(error as Error).message}` });
        }
        const problems = validateToolArguments(parsed, found.inputSchema);
        if (problems.length > 0) throw new KernelError('mcp_arguments_invalid', { detail: problems.join('; ') });
        const result = await registry.call(args.server, args.tool, parsed) as { content?: { type: string; text?: string }[]; isError?: boolean };
        const text = (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n');
        return { text, server: args.server, tool: args.tool, effectiveCapability: `mcp:${args.server}/${args.tool}`, failed: result.isError === true };
      },
    },
  };
}

export function createMcpPlugin(registry: Pick<McpRegistry, 'servers' | 'toolsOf' | 'definition' | 'call'>) {
  const disclosed = { seen: new Set<string>() };
  const { inspectTool, callTool } = createMcpTools(registry, disclosed);
  return {
    name: 'ligule-mcp',
    setup(kernel: { register(tool: unknown): () => void }) {
      // 一件服务器都没配时不登记：多两件没人用的工具会改掉每次请求的前缀字节（D12）。
      if (registry.servers().length === 0) return () => {};
      const undoCall = kernel.register(callTool);
      const undoInspect = kernel.register(inspectTool);
      return () => {
        undoInspect();
        undoCall();
      };
    },
  };
}
