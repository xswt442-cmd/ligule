// 守护进程先取得 Job Object，再创建命令；命令的退出码独立于守护进程的退出码。
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KernelError } from '../kernel/error.js';

export interface OwnedWindowsCommand {
  readonly child: ChildProcess;
  readonly completion: Promise<number>;
  cancel(): void;
}

export function spawnWindowsCommand(executable: string, args: readonly string[], cwd: string): OwnedWindowsCommand {
  const child = fork(fileURLToPath(new URL('./exec-guardian.js', import.meta.url)), [executable, ...args], {
    cwd,
    windowsHide: true,
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let cancelled = false;
  let exitCode: number | undefined;
  let failure: Error | undefined;
  const completion = new Promise<number>((resolve, reject) => {
    child.on('message', (value: unknown) => {
      if (typeof value !== 'object' || value === null) {
        failure = new KernelError('exec_guardian_protocol');
        child.kill();
        return;
      }
      const message = value as { kind?: unknown; exitCode?: unknown; code?: unknown; detail?: unknown; processId?: unknown };
      if (message.kind === 'ready' && message.processId === child.pid) return;
      if (message.kind === 'exit' && typeof message.exitCode === 'number' && Number.isInteger(message.exitCode)) {
        exitCode = message.exitCode;
        return;
      }
      if (message.kind === 'error' && typeof message.code === 'string') {
        failure = new KernelError(message.code, { detail: typeof message.detail === 'string' ? message.detail : undefined });
        return;
      }
      failure = new KernelError('exec_guardian_protocol');
      child.kill();
    });
    child.once('error', (cause) => {
      failure = new KernelError('exec_spawn_failed', { cause, detail: cause.message });
    });
    child.once('close', () => {
      if (failure !== undefined) reject(failure);
      else if (cancelled) reject(new KernelError('exec_cancelled', { detail: 'the owned command tree was terminated' }));
      else if (exitCode !== undefined) resolve(exitCode);
      else reject(new KernelError('exec_guardian_failed', { detail: 'the guardian exited without reporting the command outcome' }));
    });
  });
  return {
    child,
    completion,
    cancel() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      cancelled = true;
      // Node 持有守护进程的句柄；终止它会关闭 Job 的最后一个句柄。
      if (!child.kill()) failure = new KernelError('exec_terminate_failed', { detail: 'the guardian could not be terminated' });
    },
  };
}
