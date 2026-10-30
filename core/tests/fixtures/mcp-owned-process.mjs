import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const [rootPidPath, childPidPath, failToolsList = 'false', behavior = 'normal'] = process.argv.slice(2);
const options = new Set(behavior.split(','));
let childStarted = false;

async function startChild() {
  if (childStarted || options.has('no-child')) return;
  childStarted = true;
  const source = options.has('ignore-term')
    ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
    : 'setInterval(() => {}, 1000);';
  const child = spawn(process.execPath, ['-e', source], {
    stdio: options.has('inherit-stdio') ? 'inherit' : 'ignore',
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  await writeFile(childPidPath, String(child.pid));
}

const server = new Server({ name: 'ligule-owned-process-fixture', version: '0.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (options.has('hang-list')) await new Promise(() => {});
  if (failToolsList === 'true') return { tools: [{ name: '', inputSchema: { type: 'object' } }] };
  if (options.has('exit-after-list')) setTimeout(() => process.exit(0), 50);
  return { tools: [{ name: 'ping', description: 'Confirm the fixture is connected.', inputSchema: { type: 'object' } }] };
});
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'pong' }] }));

await writeFile(rootPidPath, String(process.pid));
await startChild();
await server.connect(new StdioServerTransport());
