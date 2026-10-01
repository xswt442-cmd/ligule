// `exec`：命令执行与进程所有权（D18）。整棵子树的终止在 Windows 上走系统自带的 `taskkill /T /F`，
// 在 POSIX 上把孩子放进自己的进程组、终止整组。两条路的实测结论与还没定的那条路线见 todo.md U1。
// 取消由调用方交进来的 signal 触发（D20 的取消边界）；本工具不做超时，超时没有进契约（D29）。
import { execFileSync, spawn } from 'node:child_process';
import { KernelError } from './error.js';
import { resolveWithin } from './paths.js';
import { boundaryOf, limitsOf } from './tools.js';

// 命令输出的上限按头尾各留一半：输出的结论常在末尾，只留头部会把失败原因截掉。
function capOutput(buffer, limit) {
  if (buffer.length <= limit) return buffer.toString('utf8');
  const half = Math.floor(limit / 2);
  return `${buffer.subarray(0, half).toString('utf8')}`
    + `\n[truncated: ${buffer.length} bytes total, ${buffer.length - limit} bytes in the middle omitted]`
    + `\n${buffer.subarray(buffer.length - half).toString('utf8')}`;
}

function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    } catch {
      // 孩子已经自己退出时 taskkill 报找不到进程，这一条不是要上报的失败。
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export const execTool = {
  name: 'exec',
  description: 'Run a command line through the platform shell with the workspace boundary as its working directory.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      cwd: { type: 'string', description: 'Working directory relative to the workspace boundary.' },
    },
    required: ['command'],
  },
  async run(args, { config, signal }) {
    if (typeof args.command !== 'string' || args.command.trim() === '') throw new KernelError('exec_command_required');
    const { execBytes } = limitsOf(config);
    const boundary = boundaryOf(config);
    const cwd = args.cwd === undefined ? boundary : await resolveWithin(boundary, args.cwd);
    // POSIX 上 detached 让孩子成为新进程组的首，终止时对 -pid 发信号带走整组；
    // Windows 没有进程组，终止用 taskkill /T。windowsHide 不弹控制台窗口。
    const child = spawn(args.command, { cwd, shell: true, detached: process.platform !== 'win32', windowsHide: true });
    const chunks = [];
    let size = 0;
    const collect = (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let cancelled = false;
    const abort = () => {
      cancelled = true;
      killTree(child);
    };
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
    signal?.removeEventListener('abort', abort);
    if (cancelled) throw new KernelError('exec_cancelled');
    return { text: capOutput(Buffer.concat(chunks, size), execBytes), exitCode };
  },
};
