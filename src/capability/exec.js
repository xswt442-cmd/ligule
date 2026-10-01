// `exec`：命令执行与进程所有权（D18）。整棵子树的终止在 Windows 上走系统自带的 `taskkill /T /F`，
// 在 POSIX 上把孩子放进自己的进程组、终止整组。两条路的实测结论与还没定的那条路线见 todo.md U1。
// 取消由调用方交进来的 signal 触发（D20 的取消边界）；本工具不做超时，超时没有进契约（D29）。
import { execFileSync, spawn } from 'node:child_process';
import { KernelError } from '../kernel/error.js';
import { resolveWithin } from './paths.js';
import { boundaryOf, limitsOf } from './limits.js';

// 命令输出的上限按头尾各留一半：输出的结论常在末尾，只留头部会把失败原因截掉。
// 头部留满一半，尾部只留最近的上限那么多字节，中间那一段的字节数算进标记里，
// 完整输出不留在内存中——一条命令写几个 GB 也不该把这一进程撑爆。
function pageOutput(total, head, tail, limit) {
  if (total <= limit) return Buffer.concat(tail, total).toString('utf8');
  const reached = Buffer.concat(tail);
  const kept = reached.subarray(Math.max(0, reached.length - (limit - head.length)));
  return `${head.toString('utf8')}\n[truncated: ${total} bytes total, ${total - head.length - kept.length} bytes in the middle omitted]\n${kept.toString('utf8')}`;
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
    if (typeof args.command !== 'string' || args.command.trim() === '') {
      throw new KernelError('exec_command_required', { detail: 'the command to run is missing' });
    }
    const { execBytes } = limitsOf(config);
    const boundary = boundaryOf(config);
    const cwd = args.cwd === undefined ? boundary : await resolveWithin(boundary, args.cwd);
    // POSIX 上 detached 让孩子成为新进程组的首，终止时对 -pid 发信号带走整组；
    // Windows 没有进程组，终止用 taskkill /T。windowsHide 不弹控制台窗口。
    // stdin 不给文件描述符：继承了那一个，等着读输入的命令就一直挂着——有些命令按启发式去读标准输入，
    // 具体是哪一家会踩到不必枚举，不给它可读的东西就够了。
    const child = spawn(args.command, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const half = Math.floor(execBytes / 2);
    let head = Buffer.alloc(0);
    const tail = [];
    let tailSize = 0;
    let total = 0;
    const collect = (chunk) => {
      total += chunk.length;
      if (head.length < half) head = Buffer.concat([head, chunk.subarray(0, half - head.length)]);
      tail.push(chunk);
      tailSize += chunk.length;
      // 尾部只留最近的上限那么多字节，更早的整块从前面丢掉：逐次重切的话，长输出的复制总量随块数涨。
      while (tailSize > execBytes && tail.length > 1) {
        tailSize -= tail[0].length;
        tail.shift();
      }
      if (tail.length === 1 && tailSize > execBytes) {
        tail[0] = tail[0].subarray(tailSize - execBytes);
        tailSize = execBytes;
      }
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
    if (cancelled) throw new KernelError('exec_cancelled', { detail: 'the command was terminated because the run was cancelled' });
    return { text: pageOutput(total, head, tail, execBytes), exitCode };
  },
};
