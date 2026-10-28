import { createInterface } from 'node:readline';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

function absolute(value, name) {
  if (typeof value !== 'string' || value === '' || !isAbsolute(value)) throw new Error(`${name}_must_be_absolute`);
  return resolve(value);
}

async function sdkFrom(root) {
  const sdkRoot = absolute(root, 'LIGULE_MCP_SDK_ROOT');
  const esm = join(sdkRoot, 'dist', 'esm');
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(join(esm, 'client', 'index.js')).href),
    import(pathToFileURL(join(esm, 'client', 'stdio.js')).href),
  ]);
  return { Client, StdioClientTransport };
}

export async function connectMcp({ cliPath, projectRoot, dataRoot, apiKeyName, apiKey, sdkRoot, cwd = projectRoot, operator = false }) {
  const cli = absolute(cliPath, 'LIGULE_MCP_CLI');
  const project = absolute(projectRoot, 'LIGULE_MCP_PROJECT_ROOT');
  const home = absolute(dataRoot, 'LIGULE_MCP_HOME');
  if (typeof apiKeyName !== 'string' || apiKeyName === '' || typeof apiKey !== 'string' || apiKey === '') {
    throw new Error('LIGULE_MCP_API_KEY_NAME_and_LIGULE_MCP_API_KEY_required');
  }
  const { Client, StdioClientTransport } = await sdkFrom(sdkRoot);
  const inheritedPath = [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter);
  const serverEnvironment = {
    LIGULE_HOME: home,
    [apiKeyName]: apiKey,
    PATH: inheritedPath,
    ...(process.env.PATHEXT === undefined ? {} : { PATHEXT: process.env.PATHEXT }),
    ...(process.platform === 'win32' ? { Path: inheritedPath } : {}),
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp-server', '--project', project, ...(operator ? ['--operator'] : [])],
    cwd: absolute(cwd, 'LIGULE_MCP_CWD'),
    env: serverEnvironment,
    stderr: 'pipe',
    maxBufferSize: 1024 * 1024,
  });
  let stderrText = '';
  transport.stderr?.setEncoding?.('utf8');
  transport.stderr?.on('data', (chunk) => { stderrText = (stderrText + chunk).slice(-16_384); });
  let markClosed;
  const processClosed = new Promise((done) => { markClosed = done; });
  const client = new Client({ name: 'ligule-mcp-e2e-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const pid = transport.pid;
  const onclose = transport.onclose;
  transport.onclose = () => {
    try { onclose?.(); }
    finally { markClosed(); }
  };
  if (pid === null) throw new Error(`mcp_server_process_missing:${stderrText}`);
  return {
    client,
    transport,
    pid,
    processClosed,
    get stderrText() { return stderrText; },
    async close() {
      await client.close();
      await processClosed;
    },
  };
}

async function runStandalone() {
  const server = await connectMcp({
    cliPath: process.env.LIGULE_MCP_CLI,
    projectRoot: process.env.LIGULE_MCP_PROJECT_ROOT,
    dataRoot: process.env.LIGULE_MCP_HOME,
    apiKeyName: process.env.LIGULE_MCP_API_KEY_NAME,
    apiKey: process.env.LIGULE_MCP_API_KEY,
    sdkRoot: process.env.LIGULE_MCP_SDK_ROOT,
  });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      try {
        const request = JSON.parse(line);
        let result;
        if (request.action === 'list') result = await server.client.listTools();
        else if (request.action === 'call' && typeof request.name === 'string') {
          result = await server.client.callTool({ name: request.name, arguments: request.arguments ?? {} });
        } else if (request.action === 'close') {
          process.stdout.write(`${JSON.stringify({ closed: true })}\n`);
          break;
        } else throw new Error('request_shape_invalid');
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
      }
    }
  } finally {
    input.close();
    await server.close();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStandalone().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
