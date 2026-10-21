import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { dataRoot } from '../kernel/config-file.js';
import { KernelError } from '../kernel/error.js';

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_WAIT_MS = 30_000;
const SOCKET_TIMEOUT_MS = MAX_WAIT_MS + 5_000;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const CODE = /^[a-z][a-z0-9_]{0,79}$/u;

export type AgentControlRequest =
  | { readonly action: 'status'; readonly after: number; readonly limit: number; readonly waitMs: number }
  | { readonly action: 'send'; readonly input: string }
  | { readonly action: 'reply'; readonly requestId: string; readonly type: 'approval'; readonly decision: 'allow' | 'deny' }
  | { readonly action: 'reply'; readonly requestId: string; readonly type: 'question'; readonly answers: unknown }
  | { readonly action: 'cancel' }
  | { readonly action: 'takeover' };

interface RuntimeDescriptor {
  readonly version: 1;
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly endpoint: string;
  readonly token: string;
  readonly ownerId: string;
}

interface RequestEnvelope {
  readonly version: 1;
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly token: string;
  readonly request: AgentControlRequest;
}

function runtimeDirectory(): string {
  return join(dataRoot(homedir()), 'agent-control-runtime');
}

function socketEndpoint(directory: string): string {
  const name = `ac-${randomUUID().replaceAll('-', '')}.sock`;
  const local = join(directory, name);
  if (Buffer.byteLength(local, 'utf8') <= 107) return local;
  const temporary = join(tmpdir(), name);
  if (Buffer.byteLength(temporary, 'utf8') > 107) throw new KernelError('agent_control_runtime_path_too_long');
  return temporary;
}

function descriptorPath(directory: string, sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return join(directory, `${digest}.json`);
}

function errorCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && CODE.test(code) ? code : 'agent_control_runtime_failed';
}

function validRequest(input: unknown): AgentControlRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new KernelError('agent_control_request_invalid');
  const value = input as Record<string, unknown>;
  switch (value.action) {
    case 'status': {
      const after = value.after ?? 0;
      const limit = value.limit ?? 50;
      const waitMs = value.waitMs ?? 0;
      if (!Number.isSafeInteger(after) || (after as number) < 0
        || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 50
        || !Number.isSafeInteger(waitMs) || (waitMs as number) < 0 || (waitMs as number) > MAX_WAIT_MS) {
        throw new KernelError('agent_control_request_invalid');
      }
      return { action: 'status', after: after as number, limit: limit as number, waitMs: waitMs as number };
    }
    case 'send':
      if (typeof value.input !== 'string' || value.input.trim() === '' || value.input.length > 65_536) {
        throw new KernelError('agent_control_request_invalid');
      }
      return { action: 'send', input: value.input };
    case 'reply':
      if (typeof value.requestId !== 'string' || value.requestId.length < 1 || value.requestId.length > 160) {
        throw new KernelError('agent_control_request_invalid');
      }
      if (value.type === 'approval' && (value.decision === 'allow' || value.decision === 'deny')) {
        return { action: 'reply', requestId: value.requestId, type: 'approval', decision: value.decision };
      }
      if (value.type === 'question' && Object.hasOwn(value, 'answers')) {
        return { action: 'reply', requestId: value.requestId, type: 'question', answers: value.answers };
      }
      throw new KernelError('agent_control_request_invalid');
    case 'cancel':
    case 'takeover':
      return { action: value.action };
    default:
      throw new KernelError('agent_control_request_invalid');
  }
}

function readRequestEnvelope(input: unknown): RequestEnvelope {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new KernelError('agent_control_request_invalid');
  const value = input as Record<string, unknown>;
  if (value.version !== 1 || typeof value.sessionId !== 'string' || !SESSION_ID.test(value.sessionId)
    || typeof value.projectRoot !== 'string' || !isAbsolute(value.projectRoot)
    || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{40,48}$/u.test(value.token)) {
    throw new KernelError('agent_control_request_invalid');
  }
  return {
    version: 1,
    sessionId: value.sessionId,
    projectRoot: value.projectRoot,
    token: value.token,
    request: validRequest(value.request),
  };
}

function constantTimeTokenMatch(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

async function writeDescriptor(path: string, descriptor: RuntimeDescriptor): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(descriptor)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new KernelError('agent_control_runtime_write_failed', { cause });
  }
}

export interface AgentControlRuntime {
  register(sessionId: string): Promise<void>;
  unregister(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export function createAgentControlRuntime(
  projectRoot: string,
  handle: (sessionId: string, request: AgentControlRequest) => Promise<unknown>,
): AgentControlRuntime {
  const directory = runtimeDirectory();
  const ownerId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\ligule-agent-control-${randomUUID()}`
    : socketEndpoint(directory);
  const sessions = new Set<string>();
  let server: Server | undefined;
  let serverClosed: Promise<void> | undefined;

  async function ensureServer(): Promise<void> {
    if (server !== undefined) return;
    await privateDirectory(directory);
    const listening = createServer((socket) => {
      socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
      let input = '';
      let replied = false;
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        if (replied) return;
        input += chunk;
        if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) {
          replied = true;
        void respond(socket, { ok: false, error: 'agent_control_request_too_large' }).catch(() => socket.destroy());
          return;
        }
        const newline = input.indexOf('\n');
        if (newline < 0) return;
        replied = true;
        const trailing = input.slice(newline + 1);
        void (async () => {
          try {
            if (trailing !== '') throw new KernelError('agent_control_request_invalid');
            const envelope = readRequestEnvelope(JSON.parse(input.slice(0, newline)));
            if (!constantTimeTokenMatch(token, envelope.token)
              || !sessions.has(envelope.sessionId)
              || envelope.projectRoot !== projectRoot) {
              throw new KernelError('agent_control_session_forbidden');
            }
            await respond(socket, { ok: true, result: await handle(envelope.sessionId, envelope.request) });
          } catch (error) {
            await respond(socket, { ok: false, error: errorCode(error) });
          }
        })().catch(() => socket.destroy());
      });
    });
    server = listening;
    await new Promise<void>((resolveListening, rejectListening) => {
      const onError = (error: Error) => { listening.off('listening', onListening); rejectListening(error); };
      const onListening = () => { listening.off('error', onError); resolveListening(); };
      listening.once('error', onError);
      listening.once('listening', onListening);
      listening.listen(endpoint);
    });
    if (process.platform !== 'win32') await chmod(endpoint, 0o600);
    listening.unref();
  }

  return {
    async register(sessionId) {
      if (!SESSION_ID.test(sessionId)) throw new KernelError('agent_control_session_invalid');
      await ensureServer();
      const descriptor: RuntimeDescriptor = { version: 1, sessionId, projectRoot, endpoint, token, ownerId };
      sessions.add(sessionId);
      try { await writeDescriptor(descriptorPath(directory, sessionId), descriptor); }
      catch (error) { sessions.delete(sessionId); throw error; }
    },
    async unregister(sessionId) {
      sessions.delete(sessionId);
      const path = descriptorPath(directory, sessionId);
      try {
        const descriptor = JSON.parse(await readFile(path, 'utf8')) as Partial<RuntimeDescriptor>;
        if (descriptor.ownerId === ownerId) await rm(path, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new KernelError('agent_control_runtime_remove_failed', { cause: error });
      }
    },
    async close() {
      if (serverClosed !== undefined) return serverClosed;
      serverClosed = (async () => {
        const failures: unknown[] = [];
        for (const sessionId of [...sessions]) {
          try { await this.unregister(sessionId); } catch (error) { failures.push(error); }
        }
        if (server !== undefined) {
          await new Promise<void>((resolveClosed) => server!.close(() => resolveClosed()));
          if (process.platform !== 'win32') await rm(endpoint, { force: true }).catch((error) => failures.push(error));
        }
        if (failures.length > 0) throw failures[0];
      })();
      return serverClosed;
    },
  };
}

async function respond(socket: Socket, response: { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: string }): Promise<void> {
  let payload: string;
  try { payload = `${JSON.stringify(response)}\n`; }
  catch { payload = '{"ok":false,"error":"agent_control_response_invalid"}\n'; }
  if (Buffer.byteLength(payload, 'utf8') > MAX_RESPONSE_BYTES) payload = '{"ok":false,"error":"agent_control_response_too_large"}\n';
  if (socket.destroyed) return;
  await new Promise<void>((resolveWrite) => socket.end(payload, resolveWrite));
}

function readDescriptor(input: unknown): RuntimeDescriptor {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new KernelError('agent_control_runtime_invalid');
  const value = input as Record<string, unknown>;
  const validEndpoint = process.platform === 'win32'
    ? typeof value.endpoint === 'string' && /^\\\\\.\\pipe\\ligule-agent-control-[0-9a-f-]{36}$/iu.test(value.endpoint)
    : typeof value.endpoint === 'string'
      && [resolve(runtimeDirectory()), resolve(tmpdir())].includes(dirname(resolve(value.endpoint)))
      && /^ac-[a-f0-9]{32}\.sock$/u.test(basename(value.endpoint));
  if (value.version !== 1 || typeof value.sessionId !== 'string' || !SESSION_ID.test(value.sessionId)
    || typeof value.projectRoot !== 'string' || !isAbsolute(value.projectRoot) || !validEndpoint
    || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{40,48}$/u.test(value.token)
    || typeof value.ownerId !== 'string' || !/^[A-Fa-f0-9-]{36}$/u.test(value.ownerId)) {
    throw new KernelError('agent_control_runtime_invalid');
  }
  return value as unknown as RuntimeDescriptor;
}

export async function requestAgentControl(
  projectRoot: string,
  sessionId: string,
  requestInput: AgentControlRequest,
): Promise<unknown> {
  const request = validRequest(requestInput);
  if (!SESSION_ID.test(sessionId) || !isAbsolute(projectRoot)) throw new KernelError('agent_control_request_invalid');
  let actualRoot: string;
  try { actualRoot = await realpath(projectRoot); }
  catch { throw new KernelError('control_project_forbidden'); }
  const directory = runtimeDirectory();
  const path = descriptorPath(directory, sessionId);
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new KernelError('agent_control_runtime_unavailable');
    throw new KernelError('agent_control_runtime_read_failed', { cause: error });
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new KernelError('agent_control_runtime_invalid');
  let descriptor: RuntimeDescriptor;
  try { descriptor = readDescriptor(JSON.parse(await readFile(path, 'utf8'))); }
  catch (cause) {
    if (cause instanceof KernelError) throw cause;
    throw new KernelError('agent_control_runtime_invalid', { cause });
  }
  if (descriptor.sessionId !== sessionId) throw new KernelError('agent_control_session_forbidden');
  if (descriptor.projectRoot !== actualRoot) throw new KernelError('control_project_forbidden');
  const envelope: RequestEnvelope = { version: 1, sessionId, projectRoot: actualRoot, token: descriptor.token, request };
  const serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) throw new KernelError('agent_control_request_too_large');
  const result = await exchange(descriptor.endpoint, serialized);
  if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new KernelError('agent_control_response_invalid');
  const response = result as Record<string, unknown>;
  if (response.ok === true) return response.result;
  if (response.ok === false && typeof response.error === 'string' && CODE.test(response.error)) throw new KernelError(response.error);
  throw new KernelError('agent_control_response_invalid');
}

function exchange(endpoint: string, request: string): Promise<unknown> {
  return new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection(endpoint);
    let response = '';
    let settled = false;
    const reject = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectResponse(error);
    };
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => reject(new KernelError('agent_control_runtime_timeout')));
    socket.once('connect', () => socket.write(request));
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response, 'utf8') > MAX_RESPONSE_BYTES) reject(new KernelError('agent_control_response_too_large'));
    });
    socket.once('end', () => {
      if (settled) return;
      settled = true;
      const newline = response.indexOf('\n');
      if (newline < 0 || response.slice(newline + 1) !== '') {
        rejectResponse(new KernelError('agent_control_response_invalid'));
        return;
      }
      try { resolveResponse(JSON.parse(response.slice(0, newline))); }
      catch (cause) { rejectResponse(new KernelError('agent_control_response_invalid', { cause })); }
    });
    socket.once('error', () => reject(new KernelError('agent_control_runtime_unavailable')));
  });
}
