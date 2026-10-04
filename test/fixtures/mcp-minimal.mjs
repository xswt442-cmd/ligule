// 一个最小的真 stdio MCP 服务器，只用来验证「定义悄悄换了」这一条（D52、D60）。
// 工具声明每次 tools/list 都从 argv[2] 指定的那份 JSON 重新读一次：进程不动而定义能换，
// 这一段是官方文件系统服务器演不出来的（它的声明编译在里面）。
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const schemaPath = process.argv[2];
const readSchema = () => JSON.parse(readFileSync(schemaPath, 'utf8'));

const server = new Server({ name: 'ligule-fixture', version: '0.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'echo', description: 'echo one value', inputSchema: readSchema() }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: 'text', text: `echo: ${String(request.params.arguments?.value)}` }],
}));

await server.connect(new StdioServerTransport());
