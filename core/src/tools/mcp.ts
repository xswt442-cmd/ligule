// 固定提供 `mcp.inspect` 和 `mcp.call` 两个工具。
//
// 模型必须先通过 `inspect` 查看服务器工具的定义和摘要，之后才能调用 `call`。
// 两者都是披露入口，不受模式筛选。
//
// `call.arguments` 使用 JSON 文本，因为 Kernel 参数模式子集不支持任意嵌套对象。
// Host 根据已披露的服务器定义校验参数，保持模型可见模式稳定。
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
      access: 'external',
      readOnly: true,
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
      async run(args: { server?: string; tool?: string }, { signal }: { signal?: AbortSignal } = {}) {
        if (args.server === undefined) return { text: registry.servers().join('\n') || 'no MCP servers are configured' };
        const tools = await registry.toolsOf(args.server, signal);
        if (args.tool === undefined) {
          return {
            text: (tools as ToolDefinition[]).map((tool) => `${tool.name}\t${tool.digest}\t${tool.description.split('\n')[0]}`).join('\n'),
            server: args.server,
            tools: (tools as ToolDefinition[]).map((tool) => ({ name: tool.name, digest: tool.digest })),
          };
        }
        const found = await registry.definition(args.server, args.tool, signal);
        // 保存已披露的工具定义及摘要，后续 `call` 必须与此定义匹配。
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
      access: 'external',
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
      // 按 `mcp:<server>/<tool>` 实际能力名称进行权限判定，而不是使用通用名称 `mcp.call`。
      capability: (args: { server?: string; tool?: string }) => `mcp:${args.server}/${args.tool}`,
      async run(args: { server: string; tool: string; arguments: string; schemaDigest: string }, { signal }: { signal?: AbortSignal } = {}) {
        const found = await registry.definition(args.server, args.tool, signal);
        // 先确认该工具已披露，再校验调用是否仍与服务器当前定义一致。
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
        const result = await registry.call(args.server, args.tool, parsed, signal) as { content?: { type: string; text?: string }[]; isError?: boolean };
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
      // 未配置服务器时不登记 MCP 工具，避免向模型暴露不可用入口。
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
