// 为 MCP 集成测试启动一个 stdio 服务器。每次收到 `tools/list` 时都重新读取命令行指定的 JSON，
// 这样测试可以在服务器进程保持运行时更换工具输入模式。
import { readFileSync } from 'node:fs';
import { Server } from '../../core/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js';
import { StdioServerTransport } from '../../core/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '../../core/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';

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
