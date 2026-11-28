import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelError } from '../../kernel/error.js';
import { loadMode } from '../../kernel/modes.js';
import { adoptForSessionDirectory } from '../../session/adopt.js';
import { sessionDirectories } from '../../session/list.js';
import type { DelegationGrant } from '../agent-control.js';
import { requiredString, type HostMethodParams } from '../protocol.js';
import type { HostClientConnection, HostSessionState, InitialSessionSettings, ProjectEnvironment } from '../types.js';

type LifecycleMethod = 'session.create' | 'session.open' | 'session.close';
type LifecycleEnvironment = Pick<ProjectEnvironment, 'projectRoot' | 'directory' | 'config' | 'modePaths'>;
type LifecycleSession<Environment extends LifecycleEnvironment> =
  Pick<HostSessionState, 'running' | 'pending' | 'adopt' | 'permissionChanging' | 'operation'>
  & { readonly environment: Environment };

interface LifecycleContext<Environment extends LifecycleEnvironment, State extends LifecycleSession<Environment>> {
  environmentFor(projectRoot: unknown): Promise<Environment>;
  opened(id: string): State | undefined;
  open(id: string): State;
  recordPathOf(id: string, environment: Environment): string;
  initialSettings(env: Environment, params: HostMethodParams, grant: DelegationGrant | undefined): Promise<InitialSessionSettings>;
  build(id: string, connection: HostClientConnection, recover: boolean, mode: string | undefined,
    env: Environment, origin?: 'explicit' | 'default', initial?: InitialSessionSettings): Promise<{ sessionId: string }>;
  noteWorkspace(env: Environment): Promise<void>;
  recordGrantUsed(grant: DelegationGrant): Promise<unknown>;
  retire(state: State): Promise<void>;
  evictEnvironment(env: Environment): void;
}

async function requireExistingRecord(path: string, sessionId: string, env: LifecycleEnvironment): Promise<void> {
  try { await access(path); return; }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    const filename = `${sessionId}.jsonl`;
    const legacy = sessionDirectories(env.config).slice(1);
    let legacyRecord = false;
    for (const directory of legacy) {
      try {
        await access(join(directory, filename));
        legacyRecord = true;
        break;
      } catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') throw legacyError;
      }
    }
    if (!legacyRecord) throw new KernelError('session_not_found', { detail: sessionId, cause });
    const adopted = await adoptForSessionDirectory(env.config, env.directory, env.projectRoot, sessionId);
    if (adopted?.busy.includes(filename)) throw new KernelError('session_locked', { detail: sessionId });
    if (adopted?.conflicts.includes(filename)) {
      throw new KernelError('session_adoption_write_failed', { detail: `${sessionId}: existing legacy records conflict` });
    }
    try { await access(path); }
    catch (adoptionError) {
      if ((adoptionError as NodeJS.ErrnoException).code !== 'ENOENT') throw adoptionError;
      throw new KernelError('session_not_found', { detail: sessionId, cause: adoptionError });
    }
  }
}

export function createSessionLifecycle<Environment extends LifecycleEnvironment, State extends LifecycleSession<Environment>>(
  context: LifecycleContext<Environment, State>,
) {
  return async (method: LifecycleMethod, sessionId: string, params: HostMethodParams, connection: HostClientConnection, grant?: DelegationGrant) => {
    if (method === 'session.close') {
      const state = context.opened(sessionId);
      if (state === undefined) throw new KernelError('session_not_open', { detail: sessionId });
      if (state.permissionChanging) throw new KernelError('permission_change_in_progress', { detail: sessionId });
      if (state.running !== undefined || state.operation !== undefined) {
        throw new KernelError('run_already_running', { detail: sessionId });
      }
      await context.retire(state);
      context.evictEnvironment(state.environment);
      return { sessionId };
    }
    if (method === 'session.create') {
      const id = randomUUID();
      const { workspaceOrigin: origin, projectRoot } = params;
      if (origin !== undefined && origin !== 'explicit' && origin !== 'default') {
        throw new KernelError('workspace_origin_unknown', { detail: `${origin}; the call takes 'explicit' or 'default', or nothing at all` });
      }
      const env = await context.environmentFor(projectRoot);
      const initial = await context.initialSettings(env, params, grant);
      const created = await context.build(id, connection, false, undefined, env,
        origin ?? (projectRoot === undefined ? 'default' : 'explicit'), initial);
      if (grant !== undefined) await context.recordGrantUsed(grant);
      await context.noteWorkspace(env);
      const hasInitialSettings = params.initialMode !== undefined || params.initialPolicy !== undefined
        || params.initialPermissionProfile !== undefined || params.initialPermissionNetwork !== undefined
        || params.confirmInitialWorkspaceTrust !== undefined
        || params.initialProvider !== undefined || params.initialModel !== undefined
        || params.initialThinkingEffort !== undefined || params.initialOutputTokens !== undefined
        || params.initialLoopIterations !== undefined;
      return hasInitialSettings ? { ...created, settingsApplied: true } : created;
    }
    if (context.opened(sessionId) !== undefined) {
      const state = context.open(sessionId);
      if (grant !== undefined) await context.recordGrantUsed(grant);
      if (params.mode !== undefined) {
        if (state.environment.modePaths === undefined) throw new KernelError('host_mode_paths_required');
        const requested = await loadMode(requiredString(params.mode, 'mode'), state.environment.modePaths);
        if (state.running === undefined) await state.adopt(requested);
        else state.pending = requested;
      }
      return { sessionId };
    }
    const env = await context.environmentFor(params.projectRoot);
    const branch = /^(.+)\.sub-(\d+)$/.exec(sessionId);
    if (branch !== null) {
      throw new KernelError('session_is_branch', { detail: `${sessionId} is a derived branch of ${branch[1]}; open the parent, or read that record with session.read` });
    }
    await requireExistingRecord(context.recordPathOf(sessionId, env), sessionId, env);
    const opened = await context.build(sessionId, connection, true,
      params.mode === undefined ? undefined : requiredString(params.mode, 'mode'), env);
    if (grant !== undefined) await context.recordGrantUsed(grant);
    await context.noteWorkspace(env);
    return opened;
  };
}
