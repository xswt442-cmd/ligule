import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { KernelError } from '../kernel/error.js';
import type { Plugin } from '../kernel/assembly.js';
import type { Kernel, ToolDefinition } from '../kernel/kernel.js';
import { runManagedExec, type ExecRunContext, type ManagedExecLease } from './exec.js';

const MAX_LOG_BYTES = 16_384;
const STARTUP_TIMEOUT_MS = 20_000;
const READY_RETRY_DELAY_MS = 100;
const READY_REQUEST_TIMEOUT_MS = 750;

type ManagedProcessAction = 'start' | 'status' | 'logs' | 'stop';
type ManagedProcessArguments = {
  readonly action?: unknown;
  readonly command?: unknown;
  readonly cwd?: unknown;
  readonly id?: unknown;
  readonly readyUrl?: unknown;
};
type ProcessStatus = 'starting' | 'running' | 'stopping' | 'exited' | 'stopped' | 'failed';

interface ManagedProcessEntry {
  readonly id: string;
  readonly port: number;
  readonly readyUrl: string;
  readonly lease: ManagedExecLease;
  readonly workspaceTrustedAtStart: boolean;
  status: ProcessStatus;
  stopping?: Promise<void>;
  exitCode?: number;
  failure?: string;
}

function loopbackUrl(value: unknown): URL {
  if (typeof value !== 'string') throw new KernelError('managed_process_url_invalid');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new KernelError('managed_process_url_invalid'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
    || url.username !== '' || url.password !== '' || url.port === '') {
    throw new KernelError('managed_process_url_invalid', { detail: 'readiness checks must use an explicit HTTP loopback address and port' });
  }
  return url;
}

async function assertPortAvailable(url: URL): Promise<void> {
  const port = Number(url.port);
  const addresses = url.hostname === 'localhost' ? ['127.0.0.1', '::1']
    : url.hostname === '[::1]' ? ['::1'] : ['127.0.0.1'];
  for (const address of addresses) {
    const server = createServer();
    let listening = false;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, address, () => { listening = true; resolve(); });
    }).catch((error: unknown) => {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code === 'EADDRINUSE') {
        throw new KernelError('managed_process_port_in_use', { detail: `loopback port ${port} is already in use` });
      }
      if (url.hostname === 'localhost' && address === '::1'
        && ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'ENOTSUP'].includes(String(code))) return;
      throw new KernelError('managed_process_port_check_failed', { cause: error });
    });
    if (!listening) continue;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function waitForReady(entry: ManagedProcessEntry, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const processExit = entry.lease.completion.then(() => ({ type: 'exit' as const }), () => ({ type: 'exit' as const }));
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new KernelError('exec_cancelled');
    if (entry.status !== 'starting') {
      throw new KernelError('managed_process_exited', { detail: entry.failure ?? `the command exited with status ${entry.exitCode ?? 'unknown'}` });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(READY_REQUEST_TIMEOUT_MS, deadline - Date.now()));
    let response: Response | undefined;
    let requestFailed = false;
    let processExited = false;
    try {
      const outcome = await Promise.race([
        fetch(entry.readyUrl, {
          signal: signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
          redirect: 'error',
        }).then(value => ({ type: 'response' as const, value })),
        processExit,
      ]);
      if (outcome.type === 'exit') {
        processExited = true;
        controller.abort();
      } else {
        response = outcome.value;
      }
    } catch {
      requestFailed = true;
    } finally {
      clearTimeout(timer);
    }
    if (signal?.aborted) throw new KernelError('exec_cancelled');
    if (processExited || entry.status !== 'starting') {
      throw new KernelError('managed_process_exited', { detail: entry.failure ?? `the command exited with status ${entry.exitCode ?? 'unknown'}` });
    }
    if (response !== undefined) {
      const ready = response.status >= 200 && response.status < 300;
      try { await response.body?.cancel(); }
      catch { requestFailed = true; }
      if (signal?.aborted) throw new KernelError('exec_cancelled');
      if (entry.status !== 'starting') {
        throw new KernelError('managed_process_exited', { detail: entry.failure ?? `the command exited with status ${entry.exitCode ?? 'unknown'}` });
      }
      if (ready && !requestFailed && Date.now() < deadline) {
        entry.status = 'running';
        return;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let exitedDuringDelay = false;
    try {
      const outcome = await Promise.race([
        delay(Math.min(READY_RETRY_DELAY_MS, remaining), undefined,
          signal === undefined ? undefined : { signal }).then(() => ({ type: 'retry' as const })),
        processExit,
      ]);
      exitedDuringDelay = outcome.type === 'exit';
    } catch (error) {
      if (signal?.aborted) throw new KernelError('exec_cancelled');
      throw error;
    }
    if (exitedDuringDelay || entry.status !== 'starting') {
      throw new KernelError('managed_process_exited', { detail: entry.failure ?? `the command exited with status ${entry.exitCode ?? 'unknown'}` });
    }
  }
  await stopEntry(entry);
  throw new KernelError('managed_process_not_ready', {
    detail: `no successful 2xx HTTP response was received from loopback port ${entry.port} within ${STARTUP_TIMEOUT_MS}ms`,
  });
}

function view(entry: ManagedProcessEntry) {
  return {
    id: entry.id,
    status: entry.status,
    ready: entry.status === 'running',
    port: entry.port,
    ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
    ...(entry.failure === undefined ? {} : { failure: entry.failure }),
    logs: entry.lease.logs().slice(-MAX_LOG_BYTES),
  };
}

function stopEntry(entry: ManagedProcessEntry): Promise<void> {
  if (entry.status === 'stopped' || entry.status === 'exited' || entry.status === 'failed') return Promise.resolve();
  if (entry.stopping !== undefined) return entry.stopping;
  entry.status = 'stopping';
  entry.stopping = entry.lease.stop().then(() => {
    entry.status = 'stopped';
  }, (error: unknown) => {
    entry.status = 'failed';
    entry.failure = error instanceof Error ? error.message : String(error);
    throw error;
  });
  return entry.stopping;
}

export interface ManagedProcessRegistry {
  start(readyUrl: URL, lease: ManagedExecLease, signal?: AbortSignal, workspaceTrustedAtStart?: boolean): Promise<Record<string, unknown>>;
  status(id: string): Record<string, unknown>;
  logs(id: string): Record<string, unknown>;
  stop(id: string): Promise<Record<string, unknown>>;
  stopAll(): Promise<void>;
  stopWorkspaceTrusted(): Promise<void>;
  close(): Promise<void>;
}

export interface ManagedProcessRegistryOptions {
  readonly validateOwner?: () => Promise<void>;
  readonly validateWorkspaceTrust?: () => Promise<void>;
}

export function createManagedProcessRegistry(options: ManagedProcessRegistryOptions = {}): ManagedProcessRegistry {
  const entries = new Map<string, ManagedProcessEntry>();
  let closed = false;
  let ownerCheck: NodeJS.Timeout | undefined;
  let checkingOwner = false;

  function get(id: string): ManagedProcessEntry {
    const entry = entries.get(id);
    if (entry === undefined) throw new KernelError('managed_process_not_found');
    return entry;
  }

  async function stopAll(): Promise<void> {
    const outcomes = await Promise.allSettled([...entries.values()].map(stopEntry));
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  async function stopWorkspaceTrusted(): Promise<void> {
    const outcomes = await Promise.allSettled([...entries.values()]
      .filter((entry) => entry.workspaceTrustedAtStart)
      .map(async (entry) => {
        if (entry.status === 'stopped' || entry.status === 'exited' || entry.status === 'failed') return;
        entry.failure = 'workspace trust was revoked';
        try { await stopEntry(entry); }
        catch (error) {
          entry.status = 'failed';
          entry.failure = `workspace trust was revoked; process-tree shutdown failed: ${error instanceof Error ? error.message : String(error)}`;
          throw error;
        }
      }));
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  async function stopAfterOwnerInvalidation(): Promise<void> {
    for (const entry of entries.values()) {
      if (entry.status === 'stopped' || entry.status === 'exited' || entry.status === 'failed') continue;
      entry.failure = 'the owning Session Grant is no longer valid';
      try { await stopEntry(entry); }
      catch (error) {
        entry.status = 'failed';
        entry.failure = `the owning Session Grant is no longer valid; process-tree shutdown failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  return {
    async start(readyUrl, lease, signal, workspaceTrustedAtStart = false) {
      if (closed || signal?.aborted) {
        await lease.stop();
        throw new KernelError(closed ? 'managed_process_owner_closed' : 'exec_cancelled');
      }
      const entry: ManagedProcessEntry = {
        id: randomUUID(),
        port: Number(readyUrl.port),
        readyUrl: readyUrl.href,
        lease,
        workspaceTrustedAtStart,
        status: 'starting',
      };
      entries.set(entry.id, entry);
      const stopOnAbort = (): void => { void stopEntry(entry).catch(() => undefined); };
      signal?.addEventListener('abort', stopOnAbort, { once: true });
      void lease.completion.then(
        () => signal?.removeEventListener('abort', stopOnAbort),
        () => signal?.removeEventListener('abort', stopOnAbort),
      );
      const validateOwner = options.validateOwner;
      const validateWorkspaceTrust = options.validateWorkspaceTrust;
      if ((validateOwner !== undefined || validateWorkspaceTrust !== undefined && workspaceTrustedAtStart) && ownerCheck === undefined) {
        ownerCheck = setInterval(() => {
          if (checkingOwner || closed) return;
          checkingOwner = true;
          void (async () => {
            await validateOwner?.();
            if (validateWorkspaceTrust !== undefined
              && [...entries.values()].some((item) => item.workspaceTrustedAtStart
                && item.status !== 'stopped' && item.status !== 'exited' && item.status !== 'failed')) {
              try { await validateWorkspaceTrust(); }
              catch { await stopWorkspaceTrusted().catch(() => undefined); }
            }
          })().catch(stopAfterOwnerInvalidation).finally(() => { checkingOwner = false; });
        }, 1_000);
        ownerCheck.unref();
      }
      void lease.completion.then((exitCode) => {
        if (entry.status === 'stopping' || entry.status === 'stopped') return;
        entry.exitCode = exitCode;
        entry.status = 'exited';
      }, (error: unknown) => {
        if (entry.status === 'stopping' || entry.status === 'stopped') return;
        entry.status = 'failed';
        entry.failure = error instanceof Error ? error.message : String(error);
      });
      try {
        await waitForReady(entry, signal);
      } catch (error) {
        await stopEntry(entry).catch(() => undefined);
        throw error;
      }
      return view(entry);
    },
    status(id) {
      return view(get(id));
    },
    logs(id) {
      const entry = get(id);
      return { id: entry.id, status: entry.status, logs: entry.lease.logs().slice(-MAX_LOG_BYTES) };
    },
    async stop(id) {
      const entry = get(id);
      await stopEntry(entry);
      return view(entry);
    },
    stopAll,
    stopWorkspaceTrusted,
    async close() {
      closed = true;
      if (ownerCheck !== undefined) clearInterval(ownerCheck);
      await stopAll();
    },
  };
}

export function managedProcessTool(registry: ManagedProcessRegistry): ToolDefinition {
  return {
    name: 'managed_process',
    access: 'exec',
    commandArgument: 'command',
    capability: () => 'exec',
    description: 'Start, inspect, read bounded logs from, or stop a long-running local process owned by this Session. Start requires an HTTP loopback health URL that returns a 2xx response when ready.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'status', 'logs', 'stop'] },
        command: { type: 'string', description: 'The command to start. Required only for action=start.' },
        cwd: { type: 'string', description: 'Optional working directory inside the workspace boundary.' },
        id: { type: 'string', description: 'Managed process handle returned by action=start.' },
        readyUrl: { type: 'string', description: 'HTTP loopback health URL; the server is ready only after it returns a 2xx response.' },
      },
      required: ['action'],
    },
    async preflight(value) {
      const args = value as ManagedProcessArguments;
      if (args.action === 'start') {
        if (typeof args.command !== 'string' || args.command.trim() === '') throw new KernelError('managed_process_command_required');
        const url = loopbackUrl(args.readyUrl);
        await assertPortAvailable(url);
        if (args.cwd !== undefined && typeof args.cwd !== 'string') throw new KernelError('managed_process_cwd_invalid');
        return;
      }
      if (args.action !== 'status' && args.action !== 'logs' && args.action !== 'stop') throw new KernelError('managed_process_action_invalid');
      if (typeof args.id !== 'string' || args.id.trim() === '') throw new KernelError('managed_process_id_required');
    },
    async run(value, context) {
      const args = value as ManagedProcessArguments;
      switch (args.action as ManagedProcessAction) {
        case 'start': {
          const readyUrl = loopbackUrl(args.readyUrl);
          return runManagedExec({ command: args.command, ...(args.cwd === undefined ? {} : { cwd: args.cwd as string }) },
            context as ExecRunContext, (lease) => registry.start(readyUrl, lease, context.signal, context.permission.workspaceTrusted));
        }
        case 'status': return registry.status(args.id as string);
        case 'logs': return registry.logs(args.id as string);
        case 'stop': return registry.stop(args.id as string);
        default: throw new KernelError('managed_process_action_invalid');
      }
    },
  };
}

export function managedProcessPlugin(registry = createManagedProcessRegistry()): Plugin<Kernel> {
  const tool = managedProcessTool(registry);
  return {
    name: 'ligule-managed-process',
    setup(kernel) {
      return kernel.register(tool);
    },
  };
}
