import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const [pidPath, listStartedPath, callStartedPath, initializeDelay = '0', listDelay = '0'] = process.argv.slice(2);

async function wait(milliseconds, signal) {
  if (signal.aborted) throw signal.reason;
  await delay(milliseconds, undefined, { signal });
}

const server = new Server({ name: 'ligule-cancel-fixture', version: '0.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
  await writeFile(listStartedPath, String(Date.now()));
  if (Number(listDelay) > 0) await wait(Number(listDelay), extra.signal);
  return {
    tools: [{
      name: 'wait',
      description: 'Wait for the requested number of milliseconds.',
      inputSchema: {
        type: 'object',
        properties: { milliseconds: { type: 'integer', minimum: 1 } },
        required: ['milliseconds'],
      },
    }],
  };
});
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  await writeFile(callStartedPath, String(Date.now()));
  await wait(request.params.arguments.milliseconds, extra.signal);
  return { content: [{ type: 'text', text: `waited ${request.params.arguments.milliseconds} ms` }] };
});

await writeFile(pidPath, String(process.pid));
if (Number(initializeDelay) > 0) await delay(Number(initializeDelay));
await server.connect(new StdioServerTransport());
