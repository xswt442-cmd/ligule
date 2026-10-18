import { Server } from '../../core/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js';
import { StdioServerTransport } from '../../core/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '../../core/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';

const server = new Server({ name: 'ligule-environment-fixture', version: '0.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'inspect_environment', inputSchema: { type: 'object', properties: {}, required: [] } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: JSON.stringify({
    ambient: process.env.LIGULE_MCP_AMBIENT_SECRET ?? null,
    explicit: process.env.MCP_FIXTURE_TOKEN ?? null,
    pathAvailable: typeof process.env.PATH === 'string' && process.env.PATH !== '',
  }) }],
}));

await server.connect(new StdioServerTransport());
