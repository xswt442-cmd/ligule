import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { KernelError } from '../kernel/error.js';
import type { Host } from './host.js';

export type OperationState = 'running' | 'done' | 'failed' | 'cancelled';

interface Operation {
  readonly operationId: string;
  readonly sessionId: string;
  state: OperationState;
  code?: string;
  summary?: string;
  settled: Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new KernelError('host_response_invalid');
  return value as Record<string, unknown>;
}

/** Public failures deliberately exclude Host details, paths, credentials and causes. */
export function controlErrorCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : 'control_failed';
}

/** One local controller owns one Host; operation IDs have this controller's lifetime. */
export function createControl(host: Host, projectRoot: string) {
  const sessions = new Set<string>();
  const operations = new Map<string, Operation>();
  const active = new Map<string, Operation>();
  let closing: Promise<void> | undefined;
  let opening = 0;
  const pending = new Set<Promise<unknown>>();
  const connection = {
    notify() {},
    async request() { return { decision: 'deny' }; },
  };

  async function tracked<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    try { return await work; }
    finally { pending.delete(work); }
  }

  function ready(): void {
    if (closing !== undefined) throw new KernelError('control_closed');
  }

  function owned(sessionId: string): void {
    ready();
    if (!sessions.has(sessionId)) throw new KernelError('session_not_open');
  }

  async function authorized(root: string): Promise<void> {
    if (!isAbsolute(root)) throw new KernelError('control_project_forbidden');
    let actual: string;
    try { actual = await realpath(resolve(root)); }
    catch { throw new KernelError('control_project_forbidden'); }
    if (actual !== projectRoot) throw new KernelError('control_project_forbidden');
  }

  async function session(method: 'session.create' | 'session.open', root: string, sessionId?: string) {
    ready();
    if ((sessionId === undefined || !sessions.has(sessionId)) && sessions.size + opening >= 64) throw new KernelError('control_session_limit');
    opening += 1;
    const work = (async () => {
      await authorized(root);
      ready();
      const result = record(await host.handle({ method, params: { projectRoot, ...(sessionId === undefined ? {} : { sessionId }) } }, connection));
      if (typeof result.sessionId !== 'string') throw new KernelError('host_response_invalid');
      sessions.add(result.sessionId);
      return { sessionId: result.sessionId };
    })();
    pending.add(work);
    try { return await work; }
    finally { opening -= 1; pending.delete(work); }
  }

  function operation(operationId: string): Operation {
    ready();
    const found = operations.get(operationId);
    if (found === undefined) throw new KernelError('operation_not_found');
    return found;
  }

  function status(found: Operation) {
    return {
      operationId: found.operationId, sessionId: found.sessionId, state: found.state,
      ...(found.code === undefined ? {} : { code: found.code }),
      ...(found.summary === undefined ? {} : { summary: found.summary }),
    };
  }

  return {
    create: (root: string) => session('session.create', root),
    open: (root: string, sessionId: string) => session('session.open', root, sessionId),
    async list(root: string, limit: number) {
      ready();
      await authorized(root);
      ready();
      const result = record(await tracked(host.handle({ method: 'sessions.list', params: { projectRoot, limit } }, connection)));
      if (!Array.isArray(result.sessions)) throw new KernelError('host_response_invalid');
      return { sessions: result.sessions.map((item: unknown) => {
        const entry = record(item);
        if (typeof entry.name !== 'string' || (entry.createdAt !== null && typeof entry.createdAt !== 'string')) {
          throw new KernelError('host_response_invalid');
        }
        return { sessionId: entry.id, name: entry.name.slice(0, 120), archived: entry.archived,
          createdAt: entry.createdAt === null ? null : entry.createdAt.slice(0, 128) };
      }) };
    },
    start(sessionId: string, input: string) {
      owned(sessionId);
      if (active.has(sessionId)) throw new KernelError('run_already_running');
      if (operations.size >= 256) {
        const oldest = [...operations.values()].find((entry) => entry.state !== 'running');
        if (oldest === undefined) throw new KernelError('control_operation_limit');
        operations.delete(oldest.operationId);
      }
      const found: Operation = { operationId: randomUUID(), sessionId, state: 'running', settled: Promise.resolve() };
      operations.set(found.operationId, found);
      active.set(sessionId, found);
      found.settled = host.handle({ method: 'run.start', params: { sessionId, input } }, connection).then(
        (result) => {
          record(result);
          found.state = 'done';
          found.summary = 'Run completed. Read session records for the result.';
        },
      ).catch((error: unknown) => {
        found.code = controlErrorCode(error);
        found.state = ['provider_cancelled', 'loop_cancelled', 'ask_user_cancelled'].includes(found.code) ? 'cancelled' : 'failed';
      }).finally(() => { if (active.get(sessionId) === found) active.delete(sessionId); });
      return status(found);
    },
    status(operationId: string) { return status(operation(operationId)); },
    async cancel(operationId: string) {
      const found = operation(operationId);
      if (found.state === 'running') {
        try { await host.handle({ method: 'run.cancel', params: { sessionId: found.sessionId } }, connection); }
        catch (error) { if (controlErrorCode(error) !== 'run_not_running') throw error; }
        await found.settled;
      }
      return { ...status(found), terminated: found.state !== 'running' };
    },
    async read(sessionId: string, before: number | undefined, limit: number, at?: number, offset = 0) {
      owned(sessionId);
      if (offset > 0 && at === undefined) throw new KernelError('session_cursor_invalid');
      const result = record(await tracked(host.handle({ method: 'session.read', params: {
        sessionId, limit, fullResults: true,
        ...(before === undefined ? {} : { before }), ...(at === undefined ? {} : { at }),
      } }, connection)));
      if (!Array.isArray(result.events)) throw new KernelError('host_response_invalid');
      const entries: { seq: number; kind: unknown; json: string; offset: number; nextOffset: number | null; totalCharacters: number }[] = [];
      let characters = 0;
      for (const value of result.events.toReversed()) {
        const event = record(value);
        if (typeof event.seq !== 'number') throw new KernelError('host_response_invalid');
        const serialized = JSON.stringify(event);
        if (offset > serialized.length) throw new KernelError('session_cursor_invalid');
        const chunk = serialized.slice(offset, offset + 8192);
        if (entries.length > 0 && (characters + chunk.length > 16384 || chunk.length < serialized.length)) break;
        entries.unshift({ seq: event.seq, kind: event.kind, json: chunk, offset,
          nextOffset: offset + chunk.length < serialized.length ? offset + chunk.length : null,
          totalCharacters: serialized.length });
        characters += chunk.length;
        if (chunk.length < serialized.length) break;
      }
      return {
        sessionId, records: entries, nextBefore: entries[0]?.seq ?? null,
        hasMore: result.hasMore === true || entries.length < result.events.length,
      };
    },
    release(): Promise<void> {
      if (closing !== undefined) return closing;
      closing = (async () => {
        const failures: unknown[] = [];
        // Observe completion failures before Host cancellation can settle active runs.
        const settled = Promise.allSettled([...operations.values()].map((found) => found.settled));
        try { await host.release(); }
        catch (error) { failures.push(error); }
        try {
          await Promise.allSettled([...pending]);
          const results = await settled;
          for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
        } catch (error) {
          failures.push(error);
        } finally {
          sessions.clear();
        }
        if (failures.length > 0) throw failures[0];
      })();
      return closing;
    },
  };
}
