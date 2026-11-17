import type { Client } from './protocol';

export type ProjectGitStatus = {
  readonly state: 'ready' | 'not_repository' | 'unsupported_filter' | 'unavailable' | 'timed_out' | 'output_too_large' | 'invalid_path';
  readonly files: readonly ProjectGitStatusEntry[];
  readonly truncated: boolean;
};

export type ProjectGitStatusEntry = {
  readonly path: string;
  readonly sourcePath?: string;
  readonly kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unmerged' | 'untracked' | 'other';
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
};

export type ProjectGitDiff = {
  readonly state: ProjectGitStatus['state'] | 'ready' | 'no_change' | 'file_not_changed' | 'untracked' | 'binary';
  readonly path: string;
  readonly staged: string | null;
  readonly unstaged: string | null;
};

const MAX_STATUS_ENTRIES = 500;
const MAX_DIFF_BYTES = 128 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkedPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(value) || value.startsWith('/') || /^[a-z]:/iu.test(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  return !normalized.startsWith('//') && normalized.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

const STATUS_STATES = ['ready', 'not_repository', 'unsupported_filter', 'unavailable', 'timed_out', 'output_too_large', 'invalid_path'];
const ENTRY_KINDS = ['added', 'modified', 'deleted', 'renamed', 'copied', 'unmerged', 'untracked', 'other'];

function checkedStatus(value: unknown): ProjectGitStatus {
  if (!object(value) || Object.keys(value).some(key => !['state', 'files', 'truncated'].includes(key))
    || !STATUS_STATES.includes(String(value.state)) || !Array.isArray(value.files) || value.files.length > MAX_STATUS_ENTRIES
    || typeof value.truncated !== 'boolean') {
    throw Object.assign(new Error('project_git_status_invalid'), { code: 'project_git_status_invalid' });
  }
  const files: ProjectGitStatusEntry[] = [];
  for (const item of value.files) {
    if (!object(item) || Object.keys(item).some(key => !['path', 'sourcePath', 'kind', 'staged', 'unstaged', 'untracked'].includes(key))
      || !checkedPath(item.path) || item.sourcePath !== undefined && !checkedPath(item.sourcePath)
      || !ENTRY_KINDS.includes(String(item.kind)) || typeof item.staged !== 'boolean'
      || typeof item.unstaged !== 'boolean' || typeof item.untracked !== 'boolean') {
      throw Object.assign(new Error('project_git_status_invalid'), { code: 'project_git_status_invalid' });
    }
    files.push({ path: item.path as string, ...(item.sourcePath === undefined ? {} : { sourcePath: item.sourcePath as string }),
      kind: item.kind as ProjectGitStatusEntry['kind'], staged: item.staged, unstaged: item.unstaged, untracked: item.untracked });
  }
  if (value.state !== 'ready' && files.length !== 0 || value.state === 'ready' && value.truncated && files.length !== MAX_STATUS_ENTRIES) {
    throw Object.assign(new Error('project_git_status_invalid'), { code: 'project_git_status_invalid' });
  }
  return { state: value.state as ProjectGitStatus['state'], files, truncated: value.truncated };
}

export async function readProjectGitStatus(client: Client, sessionId: string): Promise<ProjectGitStatus> {
  return checkedStatus(await client.call('project.git.status', { sessionId }, 15_000));
}

export async function readProjectGitDiff(client: Client, sessionId: string, path: string): Promise<ProjectGitDiff> {
  if (!checkedPath(path)) throw Object.assign(new Error('project_file_path_invalid'), { code: 'project_file_path_invalid' });
  const value = await client.call('project.git.diff', { sessionId, path }, 15_000);
  const states = [...STATUS_STATES, 'no_change', 'file_not_changed', 'untracked', 'binary'];
  if (!object(value) || Object.keys(value).some(key => !['state', 'path', 'staged', 'unstaged'].includes(key))
    || !states.includes(String(value.state)) || !checkedPath(value.path)
    || value.staged !== null && (typeof value.staged !== 'string' || value.staged.includes('\u0000')
      || new TextEncoder().encode(value.staged).byteLength > MAX_DIFF_BYTES)
    || value.unstaged !== null && (typeof value.unstaged !== 'string' || value.unstaged.includes('\u0000')
      || new TextEncoder().encode(value.unstaged).byteLength > MAX_DIFF_BYTES)
    || value.state === 'ready' && (value.staged === null && value.unstaged === null)
    || value.state !== 'ready' && (value.staged !== null || value.unstaged !== null)) {
    throw Object.assign(new Error('project_git_diff_invalid'), { code: 'project_git_diff_invalid' });
  }
  return { state: value.state as ProjectGitDiff['state'], path: value.path as string,
    staged: value.staged as string | null, unstaged: value.unstaged as string | null };
}
