// 固定提供 `mcp.inspect` 和 `mcp.call` 两个工具。
//
// 模型必须先通过 `inspect` 查看服务器工具的定义和摘要，之后才能调用 `call`。
// 两者都是披露入口，不受模式筛选。
//
// `call.arguments` 使用 JSON 文本，因为 Kernel 参数模式子集不支持任意嵌套对象。
// Host 根据已披露的服务器定义校验参数，保持模型可见模式稳定。
import { KernelError } from '../kernel/error.js';
import type { McpRegistry, ToolDefinition } from '../capability/mcp.js';
import { IMAGE_LIMITS, type ImageReference, type MediaStore } from '../capability/media.js';
import { validateToolArguments } from '../capability/mcp.js';

const LEVELS = 'without a server it lists the configured servers; with a server it lists that server\'s tools and their digests; with both it returns the full definition.';

export interface McpDisclosed {
  seen: Set<string>;
}

export interface McpAuthorization {
  authorizeServer?(server: string): void | Promise<void>;
  authorizeTool?(server: string, tool: string): void | Promise<void>;
  authorizeArguments?(server: string, tool: string, args: unknown): void | Promise<void>;
  identityDigest?(server: string): string | undefined;
}

export interface McpImages {
  readonly media: MediaStore;
  readonly sourceFor: (server: string) => ImageReference['source'] | undefined;
}

const MCP_IMAGE_COUNT_LIMIT = 4;
const MCP_IMAGE_TOTAL_BYTES_LIMIT = 16 * 1024 * 1024;
const MCP_ERROR_TEXT_BYTES = 4_000;
const MCP_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function boundedDiagnostic(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= MCP_ERROR_TEXT_BYTES) return text;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = MCP_ERROR_TEXT_BYTES; end >= MCP_ERROR_TEXT_BYTES - 4; end -= 1) {
    try { return decoder.decode(bytes.subarray(0, end)); }
    catch { /* Drop only a partial trailing UTF-8 sequence. */ }
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function imageBytesOf(value: unknown, totalBytes: number): Buffer {
  if (!isRecord(value) || typeof value.mimeType !== 'string' || !MCP_IMAGE_MIME_TYPES.has(value.mimeType)) {
    throw new KernelError('mcp_image_unsupported', { detail: 'the MCP server returned an unsupported image type' });
  }
  if (typeof value.data !== 'string' || value.data.length === 0
    || value.data.length > Math.ceil(IMAGE_LIMITS.inputBytes / 3) * 4
    || value.data.length % 4 !== 0) {
    throw new KernelError('mcp_image_invalid', { detail: 'the MCP server returned invalid base64 image data' });
  }
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== value.data) {
    throw new KernelError('mcp_image_invalid', { detail: 'the MCP server returned invalid base64 image data' });
  }
  if (bytes.length > IMAGE_LIMITS.inputBytes || totalBytes + bytes.length > MCP_IMAGE_TOTAL_BYTES_LIMIT) {
    throw new KernelError('mcp_image_bytes_exceeded');
  }
  return bytes;
}

function textBlocksOf(content: readonly unknown[]): string {
  const text: string[] = [];
  for (const item of content) {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') text.push(item.text);
  }
  return text.join('\n');
}

function key(server: string, tool: string, digest: string) {
  return `${server}/${tool}@${digest}`;
}

export function createMcpTools(
  registry: Pick<McpRegistry, 'servers' | 'toolsOf' | 'definition' | 'call'>,
  disclosed: McpDisclosed,
  authorization: McpAuthorization = {},
  images?: McpImages,
) {
  return {
    inspectTool: {
      name: 'mcp.inspect',
      access: 'inherit',
      readOnly: false,
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
      async preflight(args: { server?: string }) {
        if (args.server !== undefined) await authorization.authorizeServer?.(args.server);
      },
      async run(args: { server?: string; tool?: string }, { signal }: { signal?: AbortSignal } = {}) {
        if (args.server === undefined) return { text: registry.servers().join('\n') || 'no MCP servers are configured' };
        await authorization.authorizeServer?.(args.server);
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
      access: 'inherit',
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
      policyIdentity: (args: { server?: string }) => args.server === undefined ? undefined : authorization.identityDigest?.(args.server),
      async preflight(args: { server: string; tool: string }) {
        await authorization.authorizeTool?.(args.server, args.tool);
      },
      async run(args: { server: string; tool: string; arguments: string; schemaDigest: string }, { signal }: { signal?: AbortSignal } = {}) {
        await authorization.authorizeTool?.(args.server, args.tool);
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
        await authorization.authorizeArguments?.(args.server, args.tool, parsed);
        const result = await registry.call(args.server, args.tool, parsed, signal) as { content?: unknown[]; isError?: boolean };
        const content = Array.isArray(result.content) ? result.content : [];
        const text = textBlocksOf(content);
        if (result.isError === true) {
          throw new KernelError('mcp_tool_failed', { detail: boundedDiagnostic(text) || 'the MCP server reported a tool error' });
        }

        const imageBlocks = content.filter((item) => isRecord(item) && item.type === 'image');
        if (imageBlocks.length === 0) {
          return { text, server: args.server, tool: args.tool, effectiveCapability: `mcp:${args.server}/${args.tool}`, failed: false };
        }
        if (images === undefined) throw new KernelError('mcp_image_unsupported', { detail: 'MCP image results are not enabled for this server' });
        const source = images.sourceFor(args.server);
        if (source === undefined || !['file', 'desktop', 'browser', 'document'].includes(source)) {
          throw new KernelError('mcp_image_unsupported', { detail: 'the MCP server has no image source mapping' });
        }
        if (imageBlocks.length > MCP_IMAGE_COUNT_LIMIT) throw new KernelError('mcp_image_count_exceeded');

        let totalBytes = 0;
        const decoded = imageBlocks.map((block) => {
          const bytes = imageBytesOf(block, totalBytes);
          totalBytes += bytes.length;
          return bytes;
        });
        const references: ImageReference[] = [];
        for (const bytes of decoded) {
          signal?.throwIfAborted();
          references.push(await images.media.put(bytes, source, signal));
          signal?.throwIfAborted();
        }
        const imageNotes = references.map((reference) =>
          `Image shotId=${reference.id}, source=${reference.source}, ${reference.width}×${reference.height}, ${reference.bytes} bytes.`,
        );
        return { kind: 'image_result', text: [text, ...imageNotes].filter((item) => item !== '').join('\n'), images: references };
      },
    },
  };
}

export function createMcpPlugin(
  registry: Pick<McpRegistry, 'servers' | 'toolsOf' | 'definition' | 'call'>,
  authorization: McpAuthorization = {},
  images?: McpImages,
) {
  const disclosed = { seen: new Set<string>() };
  const { inspectTool, callTool } = createMcpTools(registry, disclosed, authorization, images);
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
