// `exec`：命令执行与进程所有权（D18）。用哪一个解释器由 Host 选定并交进来（D59），这里只负责按那一份选择起进程。
// 整棵子树的终止在 Windows 上走系统自带的 `taskkill /T /F`，在 POSIX 上把孩子放进自己的进程组、终止整组。
// 两条路的实测结论与还没定的那条路线记在项目的未定项 U1。取消由调用方交进来的 signal 触发（D20 的取消边界）；本工具不做超时，超时没有进契约（D29）。
import { execFileSync, spawn } from 'node:child_process';
import { KernelError } from '../kernel/error.js';
import { resolveWithin } from './paths.js';
import { boundaryOf, limitsOf } from './limits.js';

// Windows 上子进程写的是控制台的 OEM 码页（zh-CN 是 cp936），按 utf8 解出来是一串乱字，
// 模型与人都读不出这条命令说了什么（本机 2026-10-02 实测：cmd 报「不是内部或外部命令」，界面上是 `????`）。
// 先按 utf8 严格解，解不动再按码页解；码页问一次 chcp 记下来，不在每条命令上多花一次进程。
let oemPage;
function codePage() {
  if (oemPage === undefined) {
    try {
      oemPage = /(\d+)/.exec(execFileSync('chcp.com', [], { encoding: 'utf8' }))?.[1] ?? '';
    } catch {
      oemPage = '';
    }
  }
  return oemPage;
}

// 码页号不全是 WHATWG 的编码标签：cp936 与 936 都不认，认的是 gbk。双字节的那三个单独列，
// 其余按 windows-<号> 试（1250 到 1258 都在表里），试不出来就退回宽松解。
const DOUBLE_BYTE = { 932: 'shift_jis', 936: 'gbk', 950: 'big5' };

export function decode(bytes) {
  if (process.platform !== 'win32') return bytes.toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder(DOUBLE_BYTE[codePage()] ?? `windows-${codePage()}`).decode(bytes);
    } catch {
      // 码页不在编码表里（cp437 那一类）时退回宽松解：宁可留乱字，不丢字节。
      return bytes.toString('utf8');
    }
  }
}

// 命令输出的上限按头尾各留一半：输出的结论常在末尾，只留头部会把失败原因截掉。
// 头部留满一半，尾部只留最近的上限那么多字节，中间那一段的字节数算进标记里，
// 完整输出不留在内存中——一条命令写几个 GB 也不该把这一进程撑爆。
function pageOutput(total, head, tail, limit) {
  if (total <= limit) return decode(Buffer.concat(tail, total));
  const reached = Buffer.concat(tail);
  const kept = reached.subarray(Math.max(0, reached.length - (limit - head.length)));
  return `${decode(head)}\n[truncated: ${total} bytes total, ${total - head.length - kept.length} bytes in the middle omitted]\n${decode(kept)}`;
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
  description: 'Run a command line with the shell backend the host chose, with the workspace boundary as its working directory.',
  // 内核按这一条认出「这行文本要走解释器」（D59）：选定后端、按那一种语法解析、把事实记进会话记录都在那一条路上做。
  commandArgument: 'command',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      cwd: { type: 'string', description: 'Working directory relative to the workspace boundary.' },
    },
    required: ['command'],
  },
  async run(args, { config, signal, shell }) {
    if (typeof args.command !== 'string' || args.command.trim() === '') {
      throw new KernelError('exec_command_required', { detail: 'the command to run is missing' });
    }
    const { execBytes } = limitsOf(config);
    const boundary = boundaryOf(config);
    const cwd = args.cwd === undefined ? boundary : await resolveWithin(boundary, args.cwd);
    // shell 是内核交进来的那一份选择（D59）：判定链读的就是这一种语法，起的也就是这一个可执行文件，
    // 不再把文本交给系统默认的 shell——那样记录里读不出「按哪种语法跑的」，判定读过的语法也可能不是那一种。
    // POSIX 上 detached 让孩子成为新进程组的首，终止时对 -pid 发信号带走整组；
    // Windows 没有进程组，终止用 taskkill /T。windowsHide 不弹控制台窗口。
    // stdin 不给文件描述符：继承了那一个，等着读输入的命令就一直挂着——有些命令按启发式去读标准输入，
    // 具体是哪一家会踩到不必枚举，不给它可读的东西就够了。
    const child = spawn(shell.executable, [...shell.prefix, `${args.command}${shell.tail}`], {
      cwd,
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
