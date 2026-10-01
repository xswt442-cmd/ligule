// 内容检索的外部后端（D18）：随包分发的那一份 ripgrep，或者配置里指明的可执行文件。
// 探测就是跑一次 `--version`：只查文件在不在说明不了它能不能执行。
// 探测不到就把原因交给调用方去记日志，检索回落到 Node 自己遍历（I8 要显式报告，不静默降级）。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { KernelError } from './error.js';

// 随包分发按平台分成可选依赖包，npm 只装匹配当前平台与架构的那一个。
const PACKAGES = {
  'win32-x64': { name: 'ligule-rg-win32-x64', file: 'rg.exe' },
  'linux-x64': { name: 'ligule-rg-linux-x64', file: 'rg' },
};

function packaged(platform, arch) {
  const entry = PACKAGES[`${platform}-${arch}`];
  if (entry === undefined) return undefined;
  try {
    return createRequire(import.meta.url).resolve(`${entry.name}/${entry.file}`);
  } catch {
    return undefined;
  }
}

function probe(executable) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, ['--version'], { windowsHide: true });
    } catch (error) {
      resolve({ code: 'search_backend_failed', detail: error.code });
      return;
    }
    child.on('error', (error) => resolve({ code: 'search_backend_failed', detail: error.code }));
    child.on('close', (code) => {
      resolve(code === 0 ? { executable } : { code: 'search_backend_failed', detail: `ripgrep exited with ${code}` });
    });
  });
}

// 一次运行里每个来源只探测一次：探测要起一个进程，每次检索都探一遍太贵。
const probed = new Map();

export async function resolveRipgrep({ path, platform = process.platform, arch = process.arch } = {}) {
  const key = path ?? `${platform}-${arch}`;
  const cached = probed.get(key);
  if (cached !== undefined) return cached;
  // 配置里写的是相对路径时，按启动这个进程的那个目录算：检索要在边界内跑，
  // 子进程的当前目录会被换成边界，相对的可执行文件路径不能跟着它走。
  const candidate = path === undefined ? packaged(platform, arch) : resolve(process.cwd(), path);
  const result = candidate === undefined ? { code: 'search_backend_missing' } : await probe(candidate);
  probed.set(key, result);
  return result;
}

// 与 Node 那一条遍历交出同一形状的行：相对边界、用斜杠书写的路径，接行号与该行内容。
// 命中数到上限就终止子进程，不把整份输出读进内存（I6）。
// ripgrep 在 Windows 上打印的是反斜杠，以 `.` 为目标时还带一层 `.\` 前缀（本机 ripgrep 15.0.0 实测），
// 而命中那一行的内容里也可能有反斜杠，所以只改路径那一段。
const LINE = /^(.+?):(\d+):([\s\S]*)$/;

function normalize(line) {
  const match = LINE.exec(line);
  if (match === null) return line;
  const path = process.platform === 'win32' ? match[1].split('\\').join('/') : match[1];
  return `${path.replace(/^\.\//, '')}:${match[2]}:${match[3]}`;
}

export function searchWithRipgrep({ executable, boundary, target = '.', pattern, limit, excludes = [], signal }) {
  return new Promise((resolve, reject) => {
    // 已经取消就不起这个进程：起了再杀会留一个短暂的孤儿，而且调用方拿到的该是取消而不是后端故障。
    if (signal?.aborted) {
      reject(new KernelError('search_cancelled', { detail: 'the content search was cancelled before it started' }));
      return;
    }
    // `--no-config` 挡住宿主环境里的 RIPGREP_CONFIG_PATH 与二进制旁边的 rg.conf：
    // 那份配置能塞进 `--pre`，等于让每次检索都执行一个外人指定的程序。
    // 排除项每个名字写两条：`!**/node_modules` 让遍历根本不进这个目录，
    // `!**/node_modules/**` 管的是搜索目标本身落在里面时的情况，那一条前一种匹配不到。
    // 不带 `**/` 的 `!node_modules/**` 只排得掉搜索根下那一层，嵌套的 a/node_modules 还能命中；
    // 加了才与 Node 遍历「任意深度都跳过」一致（本机 ripgrep 15.2.0 实测）。
    // 默认多线程，命中顺序两次运行就不一样；`--sort path` 按路径排序，才守住同一输入同一输出。
    const child = spawn(executable, [
      '--no-config', '--no-ignore', '--hidden', '--no-heading', '--with-filename', '--line-number',
      '--fixed-strings', '--sort', 'path',
      ...excludes.flatMap((name) => ['--glob', `!**/${name}`, '--glob', `!**/${name}/**`]),
      '--', pattern, target,
    ], { cwd: boundary, windowsHide: true });
    const hits = [];
    let truncated = false;
    let pending = '';
    let stderr = '';
    let settled = false;

    // 取消、命中数够用、进程自己结束三条路都可能是先到那一条，所以只结算一次；
    // 取消算取消，不算后端故障，监听器在结算之后撤掉，不留在一个长期存在的信号上。
    const settle = (finish) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      finish();
    };
    const cancel = () => {
      child.kill();
      settle(() => reject(new KernelError('search_cancelled', { detail: 'the content search was cancelled before it finished' })));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    // 起进程到挂上监听之间信号也可能已经变了，那种情况补一次取消，不要把这一趟扫完才回话。
    if (signal?.aborted) cancel();

    const consume = (chunk) => {
      // 已经够数并终止了子进程，之后到达的输出不再收，否则命中数会越过上限。
      if (truncated) return;
      pending += chunk.toString('utf8');
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line === '') continue;
        if (hits.length === limit) {
          truncated = true;
          child.kill();
          return;
        }
        hits.push(normalize(line.replace(/\r$/, '')));
      }
    };

    child.stdout.on('data', consume);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => settle(() => reject(new KernelError('search_backend_failed', { cause: error, detail: `the search backend could not run: ${error.code ?? error.message}` }))));
    child.on('close', (code) => {
      // ripgrep 没有命中时以 1 退出，那是结果不是故障；2 才是它自己出错。
      if (code === 0 || code === 1 || truncated) settle(() => resolve({ hits, truncated }));
      else settle(() => reject(new KernelError('search_backend_failed', { detail: stderr.trim() || `ripgrep exited with ${code}` })));
    });
  });
}
