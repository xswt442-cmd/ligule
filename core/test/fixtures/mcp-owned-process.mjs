import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const [rootPidPath, childPidPath, failToolsList = 'false'] = process.argv.slice(2);
let childStarted = false;

async function startChild() {
  if (childStarted) return;
  childStarted = true;
  const source = 'setInterval(() => {}, 1000);';
  const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  await writeFile(childPidPath, String(child.pid));
}

const server = new Server({ name: 'ligule-owned-process-fixture', version: '0.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (failToolsList === 'true') return { tools: [{ name: '', inputSchema: { type: 'object' } }] };
  return { tools: [{ name: 'ping', description: 'Confirm the fixture is connected.', inputSchema: { type: 'object' } }] };
});
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'pong' }] }));

await writeFile(rootPidPath, String(process.pid));
await startChild();
await server.connect(new StdioServerTransport());
