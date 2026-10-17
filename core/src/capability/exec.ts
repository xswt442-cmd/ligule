// `exec` 负责命令执行和进程生命周期。Host 选择解释器并传入此处。
// Windows 进程由 Job Object 管理，POSIX 进程加入独立进程组。
// 调用方通过 signal 取消执行；此工具不设置超时。
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { KernelError } from '../kernel/error.js';
import { resolveWithin } from './paths.js';
import { boundaryOf, limitsOf, workingDirectoryOf, type CapabilityConfig } from './limits.js';
import { spawnWindowsCommand } from './windows-command.js';
import type { ShellSelection } from './shell.js';

type ExecArguments = { command?: unknown; cwd?: string };
type ExecContext = { config: CapabilityConfig; signal?: AbortSignal; shell?: ShellSelection };
type ExecResult = { text: string; exitCode: number | null };

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

export const execTool = {
  name: 'exec',
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
  async run(args: ExecArguments, { config, signal, shell }: ExecContext): Promise<ExecResult> {
    if (typeof args.command !== 'string' || args.command.trim() === '') {
      throw new KernelError('exec_command_required', { detail: 'the command to run is missing' });
    }
    if (shell === undefined) throw new KernelError('exec_shell_unavailable', { detail: 'the host did not select a shell backend for exec' });
    const { execBytes } = limitsOf(config);
    const boundary = boundaryOf(config);
    const workspaceRoot = workingDirectoryOf(config);
    const cwd = args.cwd === undefined
      ? await resolveWithin(boundary, '.', { cwd: workspaceRoot })
      : await resolveWithin(boundary, args.cwd, { cwd: workspaceRoot });
    // 使用 Kernel 指定的 shell，确保权限判定和实际执行采用同一语法及可执行文件。
    // POSIX 下创建独立进程组以便整体取消；Windows 下由守护进程分配 Job Object。隐藏 Windows 控制台窗口。
    // stdin 设为不可读，避免等待输入的命令在无人交互时一直挂起。
    const commandArgs = [...shell.prefix, `${args.command}${shell.tail}`];
    const owned = process.platform === 'win32' ? spawnWindowsCommand(shell.executable, commandArgs, cwd) : null;
    const child = owned?.child ?? spawn(shell.executable, commandArgs, {
      cwd,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      if (owned === null) killTree(child);
      else owned.cancel();
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

    let cancelled = false;
    const abort = (): void => {
      cancelled = true;
      if (owned === null) killTree(child);
      else owned.cancel();
    };
    const completion: Promise<number | null> = owned?.completion ?? new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    let exitCode: number | null;
    try {
      exitCode = await completion;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    if (cancelled) throw new KernelError('exec_cancelled', { detail: 'the command was terminated because the run was cancelled' });
    return { text: pageOutput(total, head, tail, execBytes), exitCode };
  },
};
