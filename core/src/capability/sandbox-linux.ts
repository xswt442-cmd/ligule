import { spawnSync } from 'node:child_process';
import { access, lstat, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type LinuxSandboxProfile = 'read-only' | 'workspace-write';
export type LinuxSandboxNetwork = 'disabled' | 'unrestricted';
export type CapabilityLevel = 'full' | 'partial' | 'unavailable';

export type LinuxSandboxProbeResult =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export interface PermissionCapabilities {
  readonly filesystemRead: CapabilityLevel;
  readonly filesystemWrite: CapabilityLevel;
  readonly network: CapabilityLevel;
  readonly process: CapabilityLevel;
}

export interface LinuxSandboxRequest {
  readonly profile: LinuxSandboxProfile;
  readonly network: LinuxSandboxNetwork;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly privateTempDir: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}

export type LinuxSandboxResult =
  | {
      readonly available: true;
      readonly executable: string;
      readonly argv: string[];
      readonly cwd: string;
      readonly capabilities: PermissionCapabilities;
      readonly limitations: readonly string[];
    }
  | {
      readonly available: false;
      readonly code: 'sandbox_unavailable';
      readonly reason: string;
      readonly capabilities: PermissionCapabilities;
    };

const SANDBOX_ROOT = '/run/ligule';
const WORKSPACE_TARGET = `${SANDBOX_ROOT}/workspace`;
const TEMP_TARGET = `${SANDBOX_ROOT}/tmp`;
const FIXED_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const HIDDEN_DIRECTORIES = ['/home', '/root', '/mnt', '/media', '/tmp', '/var/tmp', '/var/lib', '/var/log', '/sys', '/dev/shm'];
const RESERVED_DIRECTORIES = [...HIDDEN_DIRECTORIES, '/run'];
const ALLOWED_ENVIRONMENT = new Set(['CI', 'FORCE_COLOR', 'LANG', 'NO_COLOR', 'TERM']);
const UNAVAILABLE_CAPABILITIES: PermissionCapabilities = Object.freeze({
  filesystemRead: 'unavailable',
  filesystemWrite: 'unavailable',
  network: 'unavailable',
  process: 'unavailable',
});

class SandboxRequestError extends Error {
  readonly code = 'sandbox_request_invalid';
}

function invalid(message: string): never {
  throw new SandboxRequestError(message);
}

function isWithin(parent: string, target: string): boolean {
  const relativePath = relative(parent, target);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function hasUnsafeCharacters(value: string): boolean {
  return value.includes('\0') || value.includes('\n') || value.includes('\r');
}

function unavailable(reason: string): LinuxSandboxResult {
  return { available: false, code: 'sandbox_unavailable', reason, capabilities: UNAVAILABLE_CAPABILITIES };
}

function requestEnvironment(environment: LinuxSandboxRequest['environment']): Array<[string, string]> {
  if (environment === undefined) return [];
  if (typeof environment !== 'object' || environment === null || Array.isArray(environment)) {
    invalid('environment must be a plain object containing approved display variables');
  }
  const prototype = Object.getPrototypeOf(environment);
  if (prototype !== Object.prototype && prototype !== null) invalid('environment must be a plain object');
  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(environment)) {
    if (!ALLOWED_ENVIRONMENT.has(name)) invalid(`environment variable ${name} is not allowed in the sandbox`);
    if (typeof value !== 'string' || hasUnsafeCharacters(value) || value.length > 4096) {
      invalid(`environment variable ${name} has an invalid value`);
    }
    entries.push([name, value]);
  }
  return entries;
}

async function canonicalDirectory(path: string, name: string): Promise<string> {
  if (typeof path !== 'string' || path.trim() === '' || !isAbsolute(path) || hasUnsafeCharacters(path)) {
    invalid(`${name} must be an absolute Linux path`);
  }
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    invalid(`${name} does not resolve to an existing directory`);
  }
  const info = await stat(canonical);
  if (!info.isDirectory()) invalid(`${name} must resolve to a directory`);
  return canonical;
}

async function privateDirectory(path: string): Promise<string> {
  const canonical = await canonicalDirectory(path, 'privateTempDir');
  const original = await lstat(resolve(path));
  const info = await stat(canonical);
  const owner = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (canonical !== resolve(path) || original.isSymbolicLink() || (owner !== undefined && info.uid !== owner)
    || (info.mode & 0o077) !== 0 || (info.mode & 0o700) !== 0o700) {
    invalid('privateTempDir must be an owned, writable directory with mode 0700');
  }
  if ((await readdir(canonical)).length !== 0) invalid('privateTempDir must be empty when the sandbox starts');
  return canonical;
}

async function inspectWorkspace(root: string): Promise<string | undefined> {
  const rootInfo = await stat(root);
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return 'the workspace could not be completely inspected';
    }
    for (const entry of entries) {
      const child = resolve(directory, entry.name);
      let info;
      try {
        info = await lstat(child);
      } catch {
        return 'the workspace changed while it was being inspected';
      }
      if (info.dev !== rootInfo.dev) return 'the workspace contains a nested filesystem mount';
      if (info.isFile() && info.nlink > 1) return 'the workspace contains a multiply-linked file';
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(child);
    }
  }
  return undefined;
}

async function findBubblewrap(): Promise<string | undefined> {
  for (const candidate of ['/usr/bin/bwrap', '/bin/bwrap']) {
    try {
      const canonical = await realpath(candidate);
      const info = await stat(canonical);
      await access(canonical, constants.X_OK);
      if (info.isFile() && info.uid === 0 && (info.mode & 0o022) === 0) return canonical;
    } catch {
      // Try the next fixed system location.
    }
  }
  return undefined;
}

function probeArguments(network: LinuxSandboxNetwork): string[] {
  return [
    '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    ...(network === 'disabled' ? ['--unshare-net'] : []),
    '--ro-bind', '/', '/',
    '--tmpfs', '/run', '--dir', SANDBOX_ROOT, '--dir', WORKSPACE_TARGET, '--dir', TEMP_TARGET,
    '--remount-ro', '/run', '--proc', '/proc', '--dev', '/dev',
    ...HIDDEN_DIRECTORIES.flatMap((path) => ['--tmpfs', path]),
    '--clearenv', '--setenv', 'PATH', FIXED_PATH,
    '--', '/bin/true',
  ];
}

function probe(bwrap: string, network: LinuxSandboxNetwork): string | undefined {
  const result = spawnSync(bwrap, probeArguments(network), {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined) return `bubblewrap isolation probe failed: ${result.error.message}`;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit code ${String(result.status)}`).trim().slice(0, 1000);
    return `bubblewrap isolation probe failed: ${detail}`;
  }
  return undefined;
}

export async function probeLinuxSandboxIsolation(): Promise<LinuxSandboxProbeResult> {
  if (process.platform !== 'linux') {
    return { available: false, reason: 'the Linux bubblewrap backend is available only on Linux' };
  }
  const bwrap = await findBubblewrap();
  if (bwrap === undefined) {
    return { available: false, reason: 'bubblewrap is missing or is not a trusted system executable' };
  }
  const issue = probe(bwrap, 'disabled');
  return issue === undefined ? { available: true } : { available: false, reason: issue };
}

export async function buildLinuxSandbox(request: LinuxSandboxRequest): Promise<LinuxSandboxResult> {
  if (process.platform !== 'linux') return unavailable('the Linux bubblewrap backend is available only on Linux');
  if (request === null || typeof request !== 'object') invalid('a sandbox request is required');
  if (request.profile !== 'read-only' && request.profile !== 'workspace-write') invalid('profile must be read-only or workspace-write');
  if (request.network !== 'disabled' && request.network !== 'unrestricted') invalid('network must be disabled or unrestricted');
  if (typeof request.executable !== 'string' || !isAbsolute(request.executable) || hasUnsafeCharacters(request.executable)) {
    invalid('executable must be an absolute Linux path');
  }
  if (!Array.isArray(request.argv) || request.argv.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) {
    invalid('argv must be an array of strings without NUL characters');
  }
  const suppliedEnvironment = requestEnvironment(request.environment);
  const workspace = await canonicalDirectory(request.workspaceRoot, 'workspaceRoot');
  const cwd = await canonicalDirectory(request.cwd, 'cwd');
  if (!isWithin(workspace, cwd)) invalid('cwd must resolve inside workspaceRoot');
  if (workspace === '/' || RESERVED_DIRECTORIES.some((path) => workspace === path)) {
    invalid('workspaceRoot cannot be a system, home, mount, or temporary root');
  }
  const privateTemp = await privateDirectory(request.privateTempDir);
  if (isWithin(workspace, privateTemp) || isWithin(privateTemp, workspace)) {
    invalid('privateTempDir and workspaceRoot must be separate directory trees');
  }

  if (request.profile === 'workspace-write') {
    const workspaceIssue = await inspectWorkspace(workspace);
    if (workspaceIssue !== undefined) return unavailable(workspaceIssue);
  }

  let executable: string;
  try {
    executable = await realpath(request.executable);
    await access(executable, constants.X_OK);
  } catch {
    return unavailable('the requested executable is missing or not executable on Linux');
  }
  if (RESERVED_DIRECTORIES.some((path) => isWithin(path, executable)
    && !isWithin(workspace, executable) && !isWithin(privateTemp, executable))) {
    return unavailable('the requested executable is inside a directory hidden from the sandbox');
  }
  const bwrap = await findBubblewrap();
  if (bwrap === undefined) return unavailable('bubblewrap is missing or is not a trusted system executable');
  const probeIssue = probe(bwrap, request.network);
  if (probeIssue !== undefined) return unavailable(probeIssue);

  const executableForSandbox = isWithin(workspace, executable)
    ? `${WORKSPACE_TARGET}${relative(workspace, executable) === '' ? '' : `/${relative(workspace, executable).split(sep).join('/')}`}`
    : isWithin(privateTemp, executable)
      ? `${TEMP_TARGET}${relative(privateTemp, executable) === '' ? '' : `/${relative(privateTemp, executable).split(sep).join('/')}`}`
      : executable;
  const sandboxCwd = `${WORKSPACE_TARGET}${relative(workspace, cwd) === '' ? '' : `/${relative(workspace, cwd).split(sep).join('/')}`}`;
  const argv = [
    '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    ...(request.network === 'disabled' ? ['--unshare-net'] : []),
    '--ro-bind', '/', '/',
    '--tmpfs', '/run', '--dir', SANDBOX_ROOT, '--dir', WORKSPACE_TARGET, '--dir', TEMP_TARGET,
    ...(request.profile === 'read-only'
      ? ['--ro-bind', workspace, WORKSPACE_TARGET]
      : ['--bind', workspace, WORKSPACE_TARGET]),
    '--bind', privateTemp, TEMP_TARGET,
    '--remount-ro', '/run',
    '--proc', '/proc', '--dev', '/dev',
    ...HIDDEN_DIRECTORIES.flatMap((path) => ['--tmpfs', path]),
    '--clearenv', '--setenv', 'PATH', FIXED_PATH,
    '--setenv', 'HOME', TEMP_TARGET, '--setenv', 'TMPDIR', TEMP_TARGET,
    '--setenv', 'TMP', TEMP_TARGET, '--setenv', 'TEMP', TEMP_TARGET,
    '--setenv', 'LANG', 'C.UTF-8',
    ...suppliedEnvironment.flatMap(([name, value]) => ['--setenv', name, value]),
    '--chdir', sandboxCwd,
    '--', executableForSandbox, ...request.argv,
  ];
  const capabilities: PermissionCapabilities = Object.freeze({
    filesystemRead: 'partial',
    filesystemWrite: request.profile === 'workspace-write' ? 'partial' : 'full',
    network: 'full',
    process: 'full',
  });
  return {
    available: true,
    executable: bwrap,
    argv,
    cwd: sandboxCwd,
    capabilities,
    limitations: [
      'The read-only root still exposes readable host operating-system files outside the explicitly hidden paths.',
      ...(request.profile === 'workspace-write'
        ? [
            'The workspace was checked for existing hard links, but a concurrent same-user host process could create an external hard link after that check.',
            'Workspace and temporary paths are validated before bubblewrap starts but are not pinned by open file descriptors; a concurrent host rename can race the later mount.',
            'Nested mounts on the same filesystem device cannot be distinguished by this Node filesystem check.',
          ]
        : []),
      'The process namespace does not impose CPU, memory, or process-count limits.',
      ...(request.network === 'unrestricted' ? ['Unrestricted network access shares the host network namespace.'] : []),
    ],
  };
}
