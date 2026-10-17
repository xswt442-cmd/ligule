// 实际命令只在守护进程加入 Job 后创建，父进程死亡由 IPC 断开通知。
import { spawn } from 'node:child_process';
import { createOwnedProcessJob, type OwnedProcessJob } from './win32-job.js';

let job: OwnedProcessJob | undefined;
let disconnected = !process.connected;
let finishing = false;

function stop(): void {
  disconnected = true;
  if (job === undefined) return;
  job.close();
}

process.once('disconnect', stop);

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
  job = await createOwnedProcessJob();
  if (disconnected || !process.connected) {
    stop();
    process.exit(1);
  }
  process.send({ kind: 'ready', processId: process.pid });
  const child = spawn(executable, args, {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.once('error', (error) => finish({ kind: 'error', code: 'exec_spawn_failed', detail: error.message }));
  child.once('close', (exitCode, signal) => {
    if (exitCode === null) finish({ kind: 'error', code: 'exec_process_interrupted', detail: `the command ended with signal ${signal}` });
    else finish({ kind: 'exit', exitCode });
  });
} catch (error) {
  const failure = error as Error & { code?: string; detail?: string };
  finish({ kind: 'error', code: failure.code ?? 'exec_job_failed', detail: failure.detail ?? failure.message });
}
