import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { accessSync, realpathSync, statSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { KernelError } from '../kernel/error.js';

const STATUS_TIMEOUT_MS = 5_000;
const STATUS_MAX_OUTPUT_BYTES = 1024 * 1024;
const ERROR_MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_STATUS_ENTRIES = 500;
const MAX_DIFF_BYTES = 128 * 1024;
const MAX_GIT_PATH_LENGTH = 4096;
const WINDOWS_ENVIRONMENT_KEYS = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'] as const;

export type ProjectGitStatusEntry = {
  readonly path: string;
  readonly sourcePath?: string;
  readonly kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unmerged' | 'untracked' | 'other';
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
};

export type ProjectGitStatusResult = {
  readonly state: 'ready' | 'not_repository' | 'unsupported_filter'
    | 'unavailable' | 'timed_out' | 'output_too_large' | 'invalid_path';
  readonly files: readonly ProjectGitStatusEntry[];
  readonly truncated: boolean;
};

export type ProjectGitDiffResult = {
  readonly state: ProjectGitStatusResult['state'] | 'ready' | 'no_change' | 'file_not_changed' | 'untracked' | 'binary';
  readonly path: string;
  readonly staged: string | null;
  readonly unstaged: string | null;
};

export function projectGitDiffVersion(diff: ProjectGitDiffResult): string | undefined {
  if (diff.state !== 'ready') return undefined;
  return createHash('sha256').update(JSON.stringify([diff.path, diff.staged, diff.unstaged])).digest('hex');
}

type GitProcessResult =
  | { readonly kind: 'exit'; readonly code: number; readonly stdout: Buffer }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'output_too_large' }
  | { readonly kind: 'unavailable' };

function executablePath(): string | undefined {
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const directory of pathValue.split(delimiter)) {
    if (directory === '') continue;
    const candidate = resolve(directory, name);
    try {
      const info = statSync(candidate);
      if (!info.isFile()) continue;
      if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch { /* Keep searching the Host's fixed PATH. */ }
  }
  return undefined;
}

const GIT_EXECUTABLE = executablePath();

function environmentOf(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const available = new Map(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]));
  for (const name of WINDOWS_ENVIRONMENT_KEYS) {
    const value = available.get(name);
    if (value !== undefined) environment[name] = value;
  }
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  environment.GIT_ATTR_NOSYSTEM = '1';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GIT_PAGER = 'cat';
  environment.PAGER = 'cat';
  environment.GIT_NO_LAZY_FETCH = '1';
  environment.LC_ALL = 'C';
  return environment;
}

const GIT_ENVIRONMENT = environmentOf();

function boundedGit(args: readonly string[], cwd: string, maxOutputBytes = STATUS_MAX_OUTPUT_BYTES): Promise<GitProcessResult> {
  if (GIT_EXECUTABLE === undefined) return Promise.resolve({ kind: 'unavailable' });
  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawn(GIT_EXECUTABLE, ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
        '-c', 'core.quotepath=false', ...args], {
        cwd,
        env: GIT_ENVIRONMENT,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolveResult({ kind: 'unavailable' });
      return;
    }

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    const finish = (result: GitProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, STATUS_TIMEOUT_MS);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        overflow = true;
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > ERROR_MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill();
      }
    });
    child.once('error', () => finish({ kind: 'unavailable' }));
    child.once('close', (code: number | null) => {
      if (timedOut) finish({ kind: 'timeout' });
      else if (overflow) finish({ kind: 'output_too_large' });
      else if (code === null) finish({ kind: 'unavailable' });
      else finish({ kind: 'exit', code, stdout: Buffer.concat(stdout, stdoutBytes) });
    });
  });
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function safeRelativePath(value: string): string | undefined {
  if (value.length === 0 || value.length > MAX_GIT_PATH_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  if (process.platform !== 'win32' && value.includes('\\')) return undefined;
  const normalized = process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
  if (normalized.startsWith('/') || /^[a-z]:/iu.test(normalized) || normalized.startsWith('//')) return undefined;
  const parts = normalized.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) return undefined;
  return parts.join('/');
}

function parseStatus(bytes: Buffer): { entries: ProjectGitStatusEntry[]; invalid: boolean } {
  let records: string[];
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    records = bytes.toString('binary').split('\0').filter(record => record !== '').map(record => {
      const raw = Buffer.from(record, 'binary');
      return decoder.decode(raw);
    });
  } catch {
    return { entries: [], invalid: true };
  }
  const entries: ProjectGitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4 || record[2] !== ' ') return { entries: [], invalid: true };
    const x = record[0]!;
    const y = record[1]!;
    const path = safeRelativePath(record.slice(3));
    if (path === undefined) return { entries: [], invalid: true };
    const rename = x === 'R' || y === 'R';
    const copy = x === 'C' || y === 'C';
    const sourcePath = rename || copy ? safeRelativePath(records[++index] ?? '') : undefined;
    if ((rename || copy) && sourcePath === undefined) return { entries: [], invalid: true };
    const untracked = x === '?' && y === '?';
    const kind = untracked ? 'untracked'
      : x === 'U' || y === 'U' ? 'unmerged'
        : rename ? 'renamed'
          : copy ? 'copied'
            : x === 'A' || y === 'A' ? 'added'
              : x === 'D' || y === 'D' ? 'deleted'
                : x === 'M' || y === 'M' || x === 'T' || y === 'T' ? 'modified' : 'other';
    entries.push({ path, ...(sourcePath === undefined ? {} : { sourcePath }), kind,
      staged: !untracked && x !== ' ', unstaged: !untracked && y !== ' ', untracked });
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { entries, invalid: false };
}

function empty(state: ProjectGitStatusResult['state']): ProjectGitStatusResult {
  return { state, files: [], truncated: false };
}

export async function readProjectGitStatus(projectRoot: string): Promise<ProjectGitStatusResult> {
  if (GIT_EXECUTABLE === undefined) return empty('unavailable');
  let root: string;
  try { root = realpathSync(projectRoot); }
  catch { return empty('unavailable'); }
  const top = await boundedGit(['rev-parse', '--show-toplevel'], root, 16 * 1024);
  if (top.kind !== 'exit') return empty(top.kind === 'timeout' ? 'timed_out' : top.kind === 'output_too_large' ? 'output_too_large' : 'unavailable');
  if (top.code !== 0) return empty('not_repository');
  let repositoryRoot: string;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    repositoryRoot = realpathSync(decoder.decode(top.stdout).trim());
  } catch { return empty('unavailable'); }
  if (!samePath(repositoryRoot, root)) return empty('not_repository');

  const filters = await boundedGit(['config', '--local', '--null', '--name-only', '--get-regexp', '^filter\\..+\\.(clean|smudge|process)$'], root, 64 * 1024);
  if (filters.kind === 'timeout') return empty('timed_out');
  if (filters.kind === 'output_too_large') return empty('output_too_large');
  if (filters.kind === 'unavailable') return empty('unavailable');
  if (filters.code !== 0 && filters.code !== 1) return empty('unavailable');
  if (filters.stdout.length > 0) return empty('unsupported_filter');

  const status = await boundedGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--renames', '--no-ahead-behind'], root);
  if (status.kind === 'timeout') return empty('timed_out');
  if (status.kind === 'output_too_large') return empty('output_too_large');
  if (status.kind === 'unavailable' || status.code !== 0) return empty('unavailable');
  const parsed = parseStatus(status.stdout);
  if (parsed.invalid) return empty('invalid_path');
  const truncated = parsed.entries.length > MAX_STATUS_ENTRIES;
  return { state: 'ready', files: parsed.entries.slice(0, MAX_STATUS_ENTRIES), truncated };
}

function requestedPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_GIT_PATH_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new KernelError('project_file_path_invalid');
  const normalized = process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
  if (normalized.startsWith('/') || /^[a-z]:/iu.test(normalized) || normalized.startsWith('//')) {
    throw new KernelError('project_file_path_invalid');
  }
  const parts = normalized.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new KernelError('project_file_path_invalid');
  return parts.join('/');
}

function diffText(result: GitProcessResult): { state?: ProjectGitDiffResult['state']; text: string | null } {
  if (result.kind === 'timeout') return { state: 'timed_out', text: null };
  if (result.kind === 'output_too_large') return { state: 'output_too_large', text: null };
  if (result.kind === 'unavailable' || result.code !== 0) return { state: 'unavailable', text: null };
  if (!isUtf8(result.stdout) || result.stdout.includes(0)) return { state: 'binary', text: null };
  const text = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
  if (text.includes('Binary files ') || text.includes('GIT binary patch')) return { state: 'binary', text: null };
  return { text: text === '' ? null : text };
}

function diffFailure(state: ProjectGitDiffResult['state'], path: string): ProjectGitDiffResult {
  return { state, path, staged: null, unstaged: null };
}

export async function readProjectGitDiff(projectRoot: string, pathValue: unknown): Promise<ProjectGitDiffResult> {
  const path = requestedPath(pathValue);
  const status = await readProjectGitStatus(projectRoot);
  if (status.state !== 'ready') return diffFailure(status.state, path);
  const entry = status.files.find(file => file.path === path || file.sourcePath === path);
  if (entry === undefined) return diffFailure(status.truncated ? 'output_too_large' : 'file_not_changed', path);
  if (entry.untracked) return diffFailure('untracked', entry.path);

  const root = realpathSync(projectRoot);
  const paths = [...new Set([entry.path, ...(entry.sourcePath === undefined ? [] : [entry.sourcePath])])];
  const diffArgs = ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--unified=3'];
  const [stagedResult, unstagedResult] = await Promise.all([
    entry.staged
      ? boundedGit([...diffArgs, '--cached', '--', ...paths], root, MAX_DIFF_BYTES)
      : Promise.resolve({ kind: 'exit' as const, code: 0, stdout: Buffer.alloc(0) }),
    entry.unstaged
      ? boundedGit([...diffArgs, '--', ...paths], root, MAX_DIFF_BYTES)
      : Promise.resolve({ kind: 'exit' as const, code: 0, stdout: Buffer.alloc(0) }),
  ]);
  const staged = diffText(stagedResult);
  const unstaged = diffText(unstagedResult);
  const failure = staged.state ?? unstaged.state;
  if (failure !== undefined) return diffFailure(failure, entry.path);
  if (staged.text === null && unstaged.text === null) return diffFailure('no_change', entry.path);
  return { state: 'ready', path: entry.path, staged: staged.text, unstaged: unstaged.text };
}
