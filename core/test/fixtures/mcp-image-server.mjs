import { readFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const [imagePath] = process.argv.slice(2);
const server = new Server({ name: 'ligule-mcp-image-fixture', version: '0.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'fetch_image',
    description: 'Return an image read from the fixture workspace.',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string' } },
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const mode = request.params.arguments.mode ?? 'image';
  if (mode === 'text') return { content: [{ type: 'text', text: 'ordinary MCP response' }] };
  if (mode === 'error') return { isError: true, content: [{ type: 'text', text: '界'.repeat(5_000) }] };

  const image = await readFile(imagePath);
  const data = mode === 'bad-base64' ? 'YQ'
      : image.toString('base64');
  const mimeType = mode === 'unsupported' ? 'image/svg+xml' : 'image/png';
  if (mode === 'too-many') {
    return { content: [{ type: 'text', text: 'fixture image result' }, ...Array.from({ length: 5 }, () => ({ type: 'image', data, mimeType }))] };
  }
  return {
    content: [
      { type: 'text', text: 'fixture image result' },
      { type: 'image', data, mimeType },
    ],
  };
});

await server.connect(new StdioServerTransport());
