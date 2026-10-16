import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { createConfig } from '../kernel/config.js';
import { KernelError } from '../kernel/error.js';
import { createHost } from './host.js';
import { loadHostEnvironment } from './environment.js';
import { createControl, controlErrorCode } from './control.js';

const id = { type: 'string', minLength: 1, maxLength: 160 };
const root = { type: 'string', minLength: 1, maxLength: 4096, description: 'Absolute project root authorized when this server started.' };
const operationProperties = {
  operationId: id, sessionId: id, state: { type: 'string', enum: ['running', 'done', 'failed', 'cancelled'] },
  code: { type: 'string' }, summary: { type: 'string', maxLength: 2048 },
};
function object(properties: Record<string, object>, required: string[]) {
  return { type: 'object' as const, properties, required, additionalProperties: false };
}
const operationOutput = object(operationProperties, ['operationId', 'sessionId', 'state']);
const sessionOutput = object({ sessionId: id }, ['sessionId']);
const tools: Tool[] = [
  { name: 'ligule_session_create', description: 'Create a writable session in the authorized project. Returns its sessionId. At most 64 open sessions per server.',
    inputSchema: object({ projectRoot: root }, ['projectRoot']), outputSchema: sessionOutput },
  { name: 'ligule_session_open', description: 'Resume a persistent session in the authorized project. Missing, locked or foreign sessions fail. No operation IDs survive server restart.',
    inputSchema: object({ projectRoot: root, sessionId: id }, ['projectRoot', 'sessionId']), outputSchema: sessionOutput },
  { name: 'ligule_session_list', description: 'List up to 50 persistent sessions belonging to the authorized project. Open one before reading its records.',
    inputSchema: object({ projectRoot: root, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, ['projectRoot']),
    outputSchema: object({ sessions: { type: 'array', maxItems: 50, items: object({ sessionId: id, name: { type: 'string', maxLength: 120 }, archived: { type: 'boolean' }, createdAt: { type: ['string', 'null'], maxLength: 128 } }, ['sessionId', 'name', 'archived', 'createdAt']) } }, ['sessions']) },
  { name: 'ligule_run_start', description: 'Submit text and return immediately while the real Host runs in the background. One active run per session. Poll status and read records. IDs are process-local; the server keeps 256 recent operations and evicts the oldest completed one when full. Approval requests are denied; this tool cannot approve or change policy.',
    inputSchema: object({ sessionId: id, input: { type: 'string', minLength: 1, maxLength: 65536 } }, ['sessionId', 'input']), outputSchema: operationOutput },
  { name: 'ligule_run_status', description: 'Read the actual Host outcome: running, done, failed or cancelled, plus a bounded text summary or stable error code. Unknown or previous-process IDs fail.',
    inputSchema: object({ operationId: id }, ['operationId']), outputSchema: operationOutput },
  { name: 'ligule_run_cancel', description: 'Cancel this known operation and wait for Host cleanup. Reports terminated only after it settles. Completed operations keep their outcome; other sessions are unaffected.',
    inputSchema: object({ operationId: id }, ['operationId']), outputSchema: object({ ...operationProperties, terminated: { type: 'boolean' } }, ['operationId', 'sessionId', 'state', 'terminated']) },
  { name: 'ligule_session_read', description: 'Read real persistent records, newest page first (records inside a page are chronological). Use nextBefore as before for older pages. Each json field is a record JSON fragment, at most 8192 UTF-16 characters. If nextOffset is non-null, call with at=that seq and offset=nextOffset until null, concatenating fragments before JSON.parse. at and before are exclusive. This preserves complete large records without unbounded responses.',
    inputSchema: object({ sessionId: id, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }, before: { type: 'integer', minimum: 1 }, at: { type: 'integer', minimum: 1 }, offset: { type: 'integer', minimum: 0, default: 0 } }, ['sessionId']),
    outputSchema: object({ sessionId: id, nextBefore: { type: ['integer', 'null'] }, hasMore: { type: 'boolean' }, records: { type: 'array', maxItems: 50, items: object({ seq: { type: 'integer' }, kind: { type: 'string' }, json: { type: 'string', maxLength: 8192 }, offset: { type: 'integer' }, nextOffset: { type: ['integer', 'null'] }, totalCharacters: { type: 'integer' } }, ['seq', 'kind', 'json', 'offset', 'nextOffset', 'totalCharacters']) } }, ['sessionId', 'records', 'nextBefore', 'hasMore']) },
];

interface Arguments {
  projectRoot?: string;
  sessionId?: string;
  operationId?: string;
  input?: string;
  limit?: number;
  before?: number;
  at?: number;
  offset?: number;
}

export async function serveMcp({ projectRoot, version, flags = [], modeName }: {
  projectRoot: string; version: string; flags?: string[]; modeName?: string;
}): Promise<void> {
  if (!isAbsolute(projectRoot)) throw new KernelError('control_project_required');
  let authorizedRoot: string;
  try {
    authorizedRoot = await realpath(projectRoot);
    if (!(await stat(authorizedRoot)).isDirectory()) throw new KernelError('control_project_required');
  } catch { throw new KernelError('control_project_required'); }
  const shippedModes = fileURLToPath(new URL('../../modes/', import.meta.url));
  const { layers, ...environment } = await loadHostEnvironment(authorizedRoot, shippedModes, flags);
  const host = createHost({ ...environment,
    config: createConfig({ user: { ...environment.config, workspaceRoot: authorizedRoot } }),
    configLayers: layers,
    ...(modeName === undefined ? {} : { modeName }),
    interactive: false,
  });
  const control = createControl(host, authorizedRoot);
  const server = new Server({ name: 'ligule', version }, {
    capabilities: { tools: {} },
    instructions: 'One local stdio controller for the explicitly authorized project. List tools, create/open a session, start a run, poll status/read records, optionally cancel. Policy approval requests are denied. Disconnect cancels active runs and releases locks. Operation IDs last only for this process. Session JSONL persists.',
  });
  const ajv = new Ajv({ strict: false });
  const validators = new Map(tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));
  const outputs = new Map(tools.map((tool) => [tool.name, ajv.compile(tool.outputSchema!)]));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const validate = validators.get(request.params.name);
    if (validate === undefined) throw new McpError(ErrorCode.InvalidParams, 'tool_unknown');
    const args = request.params.arguments ?? {};
    if (!validate(args)) throw new McpError(ErrorCode.InvalidParams, 'tool_args_invalid');
    const input: Arguments = args;
    try {
      let result: Record<string, unknown>;
      switch (request.params.name) {
        case 'ligule_session_create': result = await control.create(input.projectRoot!); break;
        case 'ligule_session_open': result = await control.open(input.projectRoot!, input.sessionId!); break;
        case 'ligule_session_list': result = await control.list(input.projectRoot!, input.limit ?? 20); break;
        case 'ligule_run_start': result = control.start(input.sessionId!, input.input!); break;
        case 'ligule_run_status': result = control.status(input.operationId!); break;
        case 'ligule_run_cancel': result = await control.cancel(input.operationId!); break;
        case 'ligule_session_read': result = await control.read(input.sessionId!, input.before, input.limit ?? 20, input.at, input.offset); break;
        default: throw new KernelError('tool_unknown');
      }
      if (!outputs.get(request.params.name)!(result)) throw new KernelError('host_response_invalid');
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const result = { code: controlErrorCode(error) };
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  });
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
  let shutdown: Promise<void> | undefined;
  let finish!: () => void;
  let fail!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  function close(): void {
    if (shutdown !== undefined) return;
    shutdown = (async () => {
      try { await control.release(); }
      finally { await server.close(); }
    })();
    void shutdown.then(finish, fail);
  }
  server.onclose = close;
  server.onerror = () => { process.stderr.write('mcp_transport_error\n'); close(); };
  process.stdin.once('end', close);
  process.stdin.once('close', close);
  process.stdout.once('error', close);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  try {
    await server.connect(transport);
    await done;
  } finally {
    close();
    await shutdown;
    process.stdin.off('end', close);
    process.stdin.off('close', close);
    process.stdout.off('error', close);
    process.off('SIGINT', close);
    process.off('SIGTERM', close);
  }
}
