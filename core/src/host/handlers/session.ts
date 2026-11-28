import { access } from 'node:fs/promises';
import { KernelError } from '../../kernel/error.js';
import { branchSession } from '../../session/branch.js';
import { foldLabel } from '../../session/format.js';
import { listWorkspaceSessions, sessionDirectories, type SessionDirectoryConfig } from '../../session/list.js';
import { sessionWriterActive } from '../../session/lock.js';
import { searchSessionDirectories } from '../../session/search.js';
import { createSessionLog, type SessionLog } from '../../session/session.js';
import { requestAgentControl, type AgentControlRequest } from '../agent-control-runtime.js';
import type { SessionImagePreview } from '../image-preview.js';
import { requiredString, type HostMethodParams } from '../protocol.js';
import { exportSession, type ExportEnvironment } from '../session-export.js';
import { readForClient, readRecordPage, type SessionReadDeps } from '../session-read.js';

export const SESSION_NAME_MAX = 120;

interface ReadableSession {
  readonly id: string;
  readonly environment: ExportEnvironment;
  readonly session: SessionLog;
  readonly running?: AbortController;
}

interface SessionHandlerContext {
  readonly defaultEnvironment: ExportEnvironment;
  readonly imagePreview: SessionImagePreview;
  readonly record: SessionReadDeps;
  open(id: string): Pick<ReadableSession, 'id' | 'session'>;
  opened(id: string): ReadableSession | undefined;
  environmentFor(projectRoot: unknown): Promise<ExportEnvironment>;
  readOnlyConfig(projectRoot: string): Promise<SessionDirectoryConfig>;
}

export function createSessionHandlers(context: SessionHandlerContext) {
  const { defaultEnvironment } = context;
  const record: SessionReadDeps = context.record;
  const read = (sessionId: string, params: HostMethodParams) => readRecordPage(sessionId, params, record);

  return {
    'session.read': read,
    'session.image.preview': context.imagePreview,
    async 'session.label'(sessionId: string, { name, archived }: HostMethodParams) {
      const state = context.open(sessionId);
      if (name === undefined && archived === undefined) throw new KernelError('session_label_empty', { detail: sessionId });
      const trimmed = name?.trim() ?? '';
      if (name !== undefined && (trimmed === '' || trimmed.length > SESSION_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name))) {
        throw new KernelError('session_name_invalid', { detail: `wanted 1-${SESSION_NAME_MAX} visible characters` });
      }
      await state.session.append({
        kind: 'label',
        ignorable: true,
        ...(name === undefined ? {} : { name: trimmed }),
        ...(archived === undefined ? {} : { archived }),
      });
      return { sessionId: state.id, ...foldLabel(await state.session.read()) };
    },
    async 'session.branch'(sessionId: string, { at, projectRoot }: HostMethodParams) {
      const state = context.opened(sessionId);
      record.assertSessionId(sessionId);
      const env = state?.environment ?? await context.environmentFor(projectRoot);
      return await branchSession(env.directory, sessionId, { at, projectRoot: env.projectRoot });
    },
    async 'sessions.list'(_sessionId: string, { projectRoot, limit }: HostMethodParams) {
      const scope = projectRoot ?? defaultEnvironment.projectRoot;
      const config = await context.readOnlyConfig(scope);
      return { sessions: await listWorkspaceSessions(config, { projectRoot: scope, limit }) };
    },
    async 'sessions.search'(_sessionId: string, params: HostMethodParams) {
      const { projectRoot, sessionId: scoped, limit } = params;
      const needle = requiredString(params.query, 'query').trim();
      if (needle === '') throw new KernelError('search_query_empty', { detail: 'a search query has to say what to look for' });
      if (scoped !== undefined) record.assertSessionId(scoped);
      const opened = scoped === undefined ? undefined : context.opened(scoped);
      const scope = projectRoot ?? defaultEnvironment.projectRoot;
      const config = opened?.environment.config ?? await context.readOnlyConfig(scope);
      return {
        hits: await searchSessionDirectories(sessionDirectories(config), {
          query: needle, sessionId: scoped, projectRoot: opened === undefined ? scope : undefined, limit,
        }),
      };
    },
    async 'session.observe'(sessionId: string, { projectRoot, fullResults, limit, before, at }: HostMethodParams) {
      const env = await context.environmentFor(requiredString(projectRoot, 'projectRoot'));
      const path = record.recordPathOf(sessionId, env);
      try { await access(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new KernelError('session_not_found', { detail: sessionId });
        throw error;
      }
      const opened = context.opened(sessionId);
      const snapshot = await readForClient(opened?.session ?? createSessionLog({ directory: env.directory, id: sessionId }), sessionId, {
        fullResults, limit, before, at,
      }, { env, fillSpills: record.fillSpills });
      return { ...snapshot, writerActive: opened?.running !== undefined || await sessionWriterActive(path) };
    },
    async 'session.control'(sessionId: string, { projectRoot, request }: HostMethodParams) {
      const env = await context.environmentFor(requiredString(projectRoot, 'projectRoot'));
      return await requestAgentControl(env.projectRoot, sessionId, request as AgentControlRequest);
    },
    async 'session.export'(sessionId: string, { path }: HostMethodParams) {
      return await exportSession({
        sessionId, path: requiredString(path, 'path'),
        environmentOf: id => context.opened(id)?.environment,
        defaultEnvironment,
        branchOwner: record.branchOwner,
        unfinished: context.opened(sessionId)?.running !== undefined,
        readRecord: (id, params) => readRecordPage(id, params, record),
      });
    },
  } satisfies Record<string, (sessionId: string, params: HostMethodParams) => Promise<unknown>>;
}
