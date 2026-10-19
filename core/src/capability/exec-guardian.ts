// 实际命令只在守护进程加入 Job 后创建，父进程死亡由 IPC 断开通知。
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { KernelError } from '../kernel/error.js';
import { createOwnedProcessJob, type OwnedProcessJob } from './win32-job.js';

let job: OwnedProcessJob | undefined;
let disconnected = !process.connected;
let finishing = false;
let linuxCleanup: Promise<void> | undefined;

function cleanupOwnedDescendants(): Promise<void> {
  if (process.platform !== 'linux') return Promise.resolve();
  linuxCleanup ??= terminateLinuxDescendants();
  return linuxCleanup;
}

function stop(): void {
  disconnected = true;
  if (job !== undefined) {
    job.close();
    return;
  }
  void cleanupOwnedDescendants()
    .then(() => finish({ kind: 'error', code: 'exec_cancelled', detail: 'the owned command tree was terminated' }))
    .catch((error) => finish({ kind: 'error', code: 'exec_terminate_failed', detail: (error as Error).message }));
}

process.once('disconnect', stop);
if (process.platform === 'linux') process.once('SIGTERM', stop);
process.on('message', (message: unknown) => {
  if (typeof message === 'object' && message !== null && 'kind' in message && message.kind === 'cancel') stop();
});

function linuxDescendants(): Array<{ pid: number; state: string }> {
  const parents = new Map<number, Array<{ pid: number; state: string }>>();
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const stat = readFileSync(`/proc/${entry.name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const state = fields[0];
      const ppid = Number(fields[1]);
      if (state === undefined || !Number.isInteger(ppid)) continue;
      const children = parents.get(ppid) ?? [];
      children.push({ pid, state });
      parents.set(ppid, children);
    } catch {
      // A process may exit while /proc is being enumerated.
    }
  }
  const result: Array<{ pid: number; state: string }> = [];
  const pending = [process.pid];
  const seen = new Set(pending);
  while (pending.length > 0) {
    const parent = pending.pop();
    if (parent === undefined) continue;
    for (const child of parents.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      result.push(child);
      pending.push(child.pid);
    }
  }
  return result;
}

async function terminateLinuxDescendants(): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const descendants = linuxDescendants();
    for (const descendant of descendants) {
      if (descendant.state === 'Z') continue;
      try {
        process.kill(descendant.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (descendants.every(({ state }) => state === 'Z')) return;
    if (Date.now() >= deadline) throw new Error('the owned Linux process tree remained alive after termination');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function enableLinuxSubreaper(): Promise<void> {
  if (process.platform !== 'linux') return;
  try {
    const koffi = (await import('koffi')).default;
    const libc = koffi.load('libc.so.6');
    const prctl = libc.func('prctl', 'int', ['int', 'uintptr_t', 'uintptr_t', 'uintptr_t', 'uintptr_t']) as (
      option: number, arg2: number, arg3: number, arg4: number, arg5: number,
    ) => number;
    if (prctl(36, 1, 0, 0, 0) !== 0) throw new Error('prctl(PR_SET_CHILD_SUBREAPER) failed');
  } catch (cause) {
    throw new KernelError('permission_process_isolation_unavailable', {
      cause,
      detail: 'Linux child subreaper support could not be enabled for this command',
    });
  }
}

function finish(message: object): void {
  if (finishing) return;
  finishing = true;
  if (!process.connected || process.send === undefined) {
    stop();
    process.exit(1);
  }
  process.send(message, () => {
    if (job !== undefined) job.close();
    process.exit(1);
  });
}

try {
  if (process.send === undefined) throw new Error('exec_guardian_ipc_required');
  const [executable, ...args] = process.argv.slice(2);
  if (executable === undefined || executable === '') throw new Error('exec_guardian_executable_required');
  if (process.platform === 'win32') job = await createOwnedProcessJob();
  else if (process.platform === 'linux') await enableLinuxSubreaper();
  else throw new Error('exec_process_ownership_unavailable');
  if (disconnected || !process.connected) {
    stop();
    if (job !== undefined) process.exit(1);
    await cleanupOwnedDescendants();
    process.exit(1);
  }
  process.send({ kind: 'ready', processId: process.pid });
  const child = spawn(executable, args, {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.once('error', (error) => finish({ kind: 'error', code: 'exec_spawn_failed', detail: error.message }));
  child.once('close', (exitCode, signal) => {
    void cleanupOwnedDescendants().then(() => {
      if (exitCode === null) finish({ kind: 'error', code: 'exec_process_interrupted', detail: `the command ended with signal ${signal}` });
      else finish({ kind: 'exit', exitCode });
    }).catch((error) => finish({ kind: 'error', code: 'exec_terminate_failed', detail: (error as Error).message }));
  });
} catch (error) {
  const failure = error as Error & { code?: string; detail?: string };
  finish({ kind: 'error', code: failure.code ?? 'exec_job_failed', detail: failure.detail ?? failure.message });
}
