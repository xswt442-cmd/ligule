import { boundaryOf, workingDirectoryOf } from '../../capability/limits.js';
import { relativePathWithin } from '../../capability/paths.js';
import { KernelError } from '../../kernel/error.js';
import type { FileWriteQueue } from '../../kernel/file-write-queue.js';
import { permissionDenial, type PermissionContext } from '../../kernel/permission.js';
import type { FileChangeFact, FileChangeStore } from '../../session/file-changes.js';
import type { SessionLog } from '../../session/session.js';
import { listProjectFiles } from '../paths.js';
import { listProjectDirectory, readProjectFile, saveProjectFile, searchProjectFiles } from '../project-files.js';
import { projectGitDiffVersion, readProjectGitDiff, readProjectGitStatus } from '../project-git.js';
import type { HostMethodParams } from '../protocol.js';
import type { RuntimeConfig } from '../types.js';

interface ProjectDirectory {
  readonly projectRoot: string;
  readonly config: RuntimeConfig;
}

interface ProjectSession {
  readonly id: string;
  readonly environment: ProjectDirectory;
  readonly permission: PermissionContext;
  readonly permissionChanging?: boolean;
  readonly fileChanges: FileChangeStore;
  readonly session: Pick<SessionLog, 'append'>;
}

interface ProjectHandlerContext<State extends ProjectSession> {
  environmentFor(projectRoot: unknown): Promise<Pick<ProjectDirectory, 'projectRoot'>>;
  open(sessionId: string): State;
  requireFileAccess(state: State, writing: boolean): Promise<void>;
  serializeSessionConfiguration<Result>(sessionId: string, action: () => Promise<Result>): Promise<Result>;
  readonly fileWriteQueue: FileWriteQueue;
}

type ProjectMethod =
  | 'paths.list'
  | 'project.files.list'
  | 'project.files.search'
  | 'project.file.read'
  | 'project.file.save'
  | 'project.git.status'
  | 'project.git.diff';

export async function handleProjectRequest<State extends ProjectSession>(
  method: ProjectMethod, params: HostMethodParams, sessionId: string, context: ProjectHandlerContext<State>,
): Promise<unknown> {
  if (method === 'paths.list') {
    const env = await context.environmentFor(params.projectRoot);
    return await listProjectFiles(env.projectRoot, typeof params.query === 'string' ? params.query : '', params.limit);
  }

  async function requireUse(state: State, use: 'read' | 'write'): Promise<void> {
    await context.requireFileAccess(state, use === 'write');
    if (use === 'write' && state.permissionChanging) throw new KernelError('permission_change_in_progress');
    const denied = permissionDenial(state.permission, use);
    if (denied !== undefined) throw new KernelError(denied.code, { detail: denied.reason });
  }

  if (method === 'project.file.save') {
    return await context.serializeSessionConfiguration(sessionId, async () => {
      const state = context.open(sessionId);
      const config = state.environment.config;
      await requireUse(state, 'write');
      const result = await saveProjectFile(config, state.id, params.path,
        params.expectedVersion, params.text, context.fileWriteQueue, async () => {
          const current = context.open(sessionId);
          if (current !== state) throw new KernelError('project_file_session_changed');
          await requireUse(current, 'write');
        }, async mutation => {
          const path = relativePathWithin(boundaryOf(config), mutation.path, { cwd: workingDirectoryOf(config) });
          const fileChanges: FileChangeFact[] = [];
          await state.fileChanges.forCall(fileChanges).record({
            path,
            target: mutation.target,
            operation: 'write',
            outcome: mutation.outcome,
            beforeExists: true,
            beforeBytes: mutation.beforeBytes,
            expectedAfterExists: true,
            expectedAfterBytes: mutation.expectedAfterBytes,
            allowReadback: true,
          });
          if (fileChanges.length !== 1) return false;
          await state.session.append({ kind: 'workspaceFileChange', ignorable: true, source: 'desktop', fileChanges });
          return true;
        });
      return {
        saved: result.saved,
        changed: result.changed,
        version: result.version,
        recorded: result.recorded,
        outcome: result.outcome,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      };
    });
  }

  const state = context.open(sessionId);
  await requireUse(state, 'read');
  const { config, projectRoot } = state.environment;
  switch (method) {
    case 'project.files.list':
      return await listProjectDirectory(config, params.path, params.offset, params.limit);
    case 'project.files.search':
      return await searchProjectFiles(config, params.query, params.path, params.offset, params.limit);
    case 'project.file.read':
      return await readProjectFile(config, state.id, params.path, params.offsetBytes, params.limitBytes);
    case 'project.git.status':
      return await readProjectGitStatus(projectRoot, boundaryOf(config));
    case 'project.git.diff': {
      const diff = await readProjectGitDiff(projectRoot, boundaryOf(config), params.path);
      const version = projectGitDiffVersion(diff);
      return { ...diff, ...(version === undefined ? {} : { version }) };
    }
  }
}
