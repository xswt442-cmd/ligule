// `exec` 负责命令执行和进程生命周期。Host 选择解释器并传入此处。
// Windows 进程由 Job Object 管理，Linux 命令由子收养者守护进程管理；受限 Profile 使用可用的 OS Sandbox。
// 调用方通过 signal 取消执行，配置上限同时限制命令运行时间。
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { KernelError } from '../kernel/error.js';
import { resolveWithin } from './paths.js';
import { boundaryOf, limitsOf, workingDirectoryOf, type CapabilityConfig } from './limits.js';
import { spawnWindowsCommand, type OwnedWindowsCommand } from './windows-command.js';
import { buildLinuxSandbox, type PermissionCapabilities } from './sandbox-linux.js';
import type { PermissionContext } from '../kernel/permission.js';
import type { ShellSelection } from './shell.js';

type ExecArguments = { command?: unknown; cwd?: string };
type ExecContext = { config: CapabilityConfig; permission: PermissionContext; signal?: AbortSignal; shell?: ShellSelection };
type ExecResult = { text: string; exitCode: number | null };

const MAX_EXEC_TIMEOUT_MS = 600_000;
const EXEC_ENVIRONMENT = new Set([
  'appdata', 'ci', 'comspec', 'force_color', 'home', 'homedrive', 'homepath', 'lang', 'lc_all',
  'localappdata', 'no_color', 'path', 'pathext', 'systemdrive', 'systemroot', 'term', 'tmp',
  'temp', 'tmpdir', 'userprofile', 'windir',
]);
const SANDBOX_ENVIRONMENT = new Set(['CI', 'FORCE_COLOR', 'LANG', 'NO_COLOR', 'TERM']);

function executionEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && EXEC_ENVIRONMENT.has(name.toLowerCase())) environment[name] = value;
  }
  return environment;
}

function sandboxEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && SANDBOX_ENVIRONMENT.has(name.toUpperCase())) allowed[name.toUpperCase()] = value;
  }
  return allowed;
}

function executionTimeout(config: CapabilityConfig): number {
  const configured = config.limits?.execTimeoutMs;
  const timeout = configured === undefined ? limitsOf(config).execTimeoutMs : configured;
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_EXEC_TIMEOUT_MS) {
    throw new KernelError('exec_timeout_invalid', {
      detail: `limits.execTimeoutMs must be a positive safe integer no greater than ${MAX_EXEC_TIMEOUT_MS}`,
    });
  }
  return timeout;
}

function permissionMode(permission: PermissionContext | undefined): 'direct' | 'sandboxed' {
  if (permission === undefined) throw new KernelError('exec_permission_required');
  if (!['read-only', 'workspace-write', 'full-access'].includes(permission.profile)) {
    throw new KernelError('permission_profile_invalid');
  }
  if (!['policy', 'unrestricted', 'disabled'].includes(permission.network)) {
    throw new KernelError('permission_network_mode_invalid');
  }
  if (permission.profile === 'full-access') {
    if (permission.network !== 'unrestricted') {
      throw new KernelError('permission_network_isolation_unavailable', {
        detail: 'full-access shell execution requires unrestricted network access on this backend',
      });
    }
    if (process.platform !== 'win32' && process.platform !== 'linux') {
      throw new KernelError('permission_process_isolation_unavailable', {
        detail: `the ${process.platform} exec backend cannot guarantee ownership of detached descendants`,
      });
    }
    return 'direct';
  }
  if (process.platform !== 'linux') {
    throw new KernelError('permission_sandbox_unavailable', {
      detail: `the ${process.platform} exec backend cannot enforce the ${permission.profile} profile`,
    });
  }
  return 'sandboxed';
}

function requireFullCapability(
  capabilities: PermissionCapabilities,
  name: keyof PermissionCapabilities,
  code: string,
): void {
  if (capabilities[name] !== 'full') {
    throw new KernelError(code, { detail: `the Linux exec backend reported ${name}=${capabilities[name]}` });
  }
}

// Windows 命令输出可能使用控制台 OEM 编码，不能始终按 UTF-8 解码。
// 先尝试严格 UTF-8；失败时读取当前代码页并按该编码解码，代码页信息在进程内缓存。
let oemPage: string | undefined;
function codePage(): string {
  if (oemPage === undefined) {
    try {
      oemPage = /(\d+)/.exec(execFileSync('chcp.com', [], { encoding: 'utf8' }))?.[1] ?? '';
    } catch {
      oemPage = '';
    }
  }
  return oemPage;
}

// Windows 代码页名称与 WHATWG 编码标签不完全一致；为常见中文代码页提供映射，其余尝试 `windows-<编号>`。
const DOUBLE_BYTE: Readonly<Record<string, string>> = { 932: 'shift_jis', 936: 'gbk', 950: 'big5' };

export function decode(bytes: Buffer): string {
  if (process.platform !== 'win32') return bytes.toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder(DOUBLE_BYTE[codePage()] ?? `windows-${codePage()}`).decode(bytes);
    } catch {
      // 编码不受支持时使用宽松 UTF-8 解码，保留输出字节而不抛错。
      return bytes.toString('utf8');
    }
  }
}

// 输出超限时保留开头和末尾片段，并在中间添加截断说明；末尾通常包含最终结果和错误原因。
// 流式收集只保留预算范围内的内容，避免大输出耗尽内存。
function pageOutput(total: number, head: Buffer, tail: Buffer[], limit: number): string {
  if (total <= limit) return decode(Buffer.concat(tail, total));
  const reached = Buffer.concat(tail);
  const kept = reached.subarray(Math.max(0, reached.length - (limit - head.length)));
  return `${decode(head)}\n[truncated: ${total} bytes total, ${total - head.length - kept.length} bytes in the middle omitted]\n${decode(kept)}`;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error;
  }
}

async function confirmProcessGroupStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return;
      throw new KernelError('exec_terminate_failed', { cause: error, detail: 'the command process group could not be checked after termination' });
    }
    if (Date.now() >= deadline) {
      throw new KernelError('exec_terminate_failed', { detail: 'the command process group remained alive after termination' });
    }
    await delay(20);
  }
}

async function createPrivateTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-exec-'));
  try {
    await chmod(directory, 0o700);
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new KernelError('exec_sandbox_setup_failed', { cause: error, detail: 'the private temporary directory could not be secured' });
  }
}

export const execTool = {
  name: 'exec',
  access: 'exec' as const,
  description: 'Run a command line with the shell backend the host chose. The default working directory is the workspace root; an explicit cwd is relative to that root and must resolve inside the workspace boundary.',
  // 该命令必须使用 Kernel 选定的解释器；解析、权限判定、执行记录均依据同一后端。
  commandArgument: 'command',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      cwd: { type: 'string', description: 'Optional working directory relative to the workspace root, within the workspace boundary.' },
    },
    required: ['command'],
  },
  async run(args: ExecArguments, { config, permission, signal, shell }: ExecContext): Promise<ExecResult> {
    if (typeof args.command !== 'string' || args.command.trim() === '') {
      throw new KernelError('exec_command_required', { detail: 'the command to run is missing' });
    }
    if (shell === undefined) throw new KernelError('exec_shell_unavailable', { detail: 'the host did not select a shell backend for exec' });
    const mode = permissionMode(permission);
    const timeoutMs = executionTimeout(config);
    const { execBytes } = limitsOf(config);
    const boundary = boundaryOf(config);
    const workspaceRoot = workingDirectoryOf(config);
    const cwd = args.cwd === undefined
      ? await resolveWithin(boundary, '.', { cwd: workspaceRoot })
      : await resolveWithin(boundary, args.cwd, { cwd: workspaceRoot });
    const commandArgs = [...shell.prefix, `${args.command}${shell.tail}`];
    const environment = executionEnvironment();
    let executable = shell.executable;
    let argv = commandArgs;
    let privateTempDir: string | undefined;
    if (mode === 'sandboxed') {
      if (permission === undefined || permission.profile === 'full-access') throw new KernelError('exec_permission_required');
      if (signal?.aborted) throw new KernelError('exec_cancelled', { detail: 'the run was cancelled before the command started' });
      privateTempDir = await createPrivateTempDir();
      try {
        const result = await buildLinuxSandbox({
          profile: permission.profile,
          network: permission.network === 'unrestricted' ? 'unrestricted' : 'disabled',
          workspaceRoot: boundary,
          cwd,
          privateTempDir,
          executable: shell.executable,
          argv: commandArgs,
          environment: sandboxEnvironment(environment),
        });
        if (!result.available) {
          throw new KernelError('permission_sandbox_unavailable', { detail: result.reason });
        }
        if (permission.profile === 'read-only') {
          requireFullCapability(result.capabilities, 'filesystemRead', 'permission_sandbox_unavailable');
          requireFullCapability(result.capabilities, 'filesystemWrite', 'permission_sandbox_unavailable');
        } else {
          requireFullCapability(result.capabilities, 'filesystemWrite', 'permission_sandbox_unavailable');
        }
        requireFullCapability(result.capabilities, 'process', 'permission_process_isolation_unavailable');
        requireFullCapability(result.capabilities, 'network', 'permission_network_isolation_unavailable');
        executable = result.executable;
        argv = result.argv;
      } catch (error) {
        await rm(privateTempDir, { recursive: true, force: true });
        privateTempDir = undefined;
        if (error instanceof KernelError) throw error;
        throw new KernelError('exec_sandbox_setup_failed', { cause: error });
      }
    }

    if (signal?.aborted) {
      if (privateTempDir !== undefined) await rm(privateTempDir, { recursive: true, force: true });
      throw new KernelError('exec_cancelled', { detail: 'the run was cancelled before the command started' });
    }

    let owned: OwnedWindowsCommand | null;
    let child: ChildProcess;
    try {
      owned = process.platform === 'win32' || process.platform === 'linux'
        ? spawnWindowsCommand(executable, argv, cwd, environment)
        : null;
      child = owned?.child ?? spawn(executable, argv, {
        cwd,
        env: environment,
        detached: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (privateTempDir !== undefined) await rm(privateTempDir, { recursive: true, force: true });
      if (error instanceof KernelError) throw error;
      throw new KernelError('exec_spawn_failed', { cause: error, detail: error instanceof Error ? error.message : undefined });
    }
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      if (owned === null) killTree(child);
      else owned.cancel();
      if (privateTempDir !== undefined) await rm(privateTempDir, { recursive: true, force: true });
      throw new KernelError('exec_spawn_failed', { detail: 'the command process did not provide output pipes' });
    }
    const half = Math.floor(execBytes / 2);
    let head = Buffer.alloc(0);
    const tail: Buffer[] = [];
    let tailSize = 0;
    let total = 0;
    const collect = (chunk: Buffer): void => {
      total += chunk.length;
      if (head.length < half) head = Buffer.concat([head, chunk.subarray(0, half - head.length)]);
      tail.push(chunk);
      tailSize += chunk.length;
      // 只保留最近的输出预算；按流片段增量丢弃旧字节，避免长输出造成重复复制。
      while (tailSize > execBytes && tail.length > 1) {
        tailSize -= tail[0].length;
        tail.shift();
      }
      if (tail.length === 1 && tailSize > execBytes) {
        tail[0] = tail[0].subarray(tailSize - execBytes);
        tailSize = execBytes;
      }
    };
    stdout.on('data', collect);
    stderr.on('data', collect);

    let termination: 'cancelled' | 'timeout' | undefined;
    let terminationFailure: unknown;
    const terminate = (reason: 'cancelled' | 'timeout'): void => {
      if (termination !== undefined) return;
      termination = reason;
      try {
        if (owned === null) killTree(child);
        else owned.cancel();
      } catch (error) {
        terminationFailure = error;
        if (owned === null) {
          try { child.kill('SIGKILL'); } catch (fallbackError) { terminationFailure = fallbackError; }
        }
      }
    };
    const abort = (): void => terminate('cancelled');
    const completion: Promise<number | null> = owned?.completion ?? new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const timer = setTimeout(() => terminate('timeout'), timeoutMs);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    let exitCode: number | null;
    let completionFailure: unknown;
    let completionFailed = false;
    let processGroupRemains = false;
    try {
      exitCode = await completion;
    } catch (error) {
      exitCode = null;
      completionFailure = error;
      completionFailed = true;
      if (termination !== undefined && errorCode(error) === 'exec_terminate_failed') {
        terminationFailure = error;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (termination !== undefined && owned === null && child.pid !== undefined) {
        try {
          await confirmProcessGroupStopped(child.pid);
        } catch (error) {
          terminationFailure ??= error;
          processGroupRemains = true;
        }
      }
      if (privateTempDir !== undefined && !processGroupRemains) {
        try {
          await rm(privateTempDir, { recursive: true, force: true });
        } catch (error) {
          throw new KernelError('exec_sandbox_cleanup_failed', { cause: error, detail: 'the private temporary directory could not be removed' });
        }
      }
    }
    if (termination !== undefined) {
      if (terminationFailure !== undefined) {
        throw new KernelError('exec_terminate_failed', { cause: terminationFailure, detail: 'the command process tree could not be terminated' });
      }
      if (termination === 'timeout') {
        throw new KernelError('exec_timeout', { detail: `the command exceeded its ${timeoutMs}ms execution limit` });
      }
      throw new KernelError('exec_cancelled', { detail: 'the command was terminated because the run was cancelled' });
    }
    if (completionFailed) {
      if (completionFailure instanceof KernelError) throw completionFailure;
      throw new KernelError('exec_spawn_failed', {
        cause: completionFailure,
        detail: completionFailure instanceof Error ? completionFailure.message : undefined,
      });
    }
    return { text: pageOutput(total, head, tail, execBytes), exitCode };
  },
};
