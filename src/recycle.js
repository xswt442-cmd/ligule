// 删除的两条去处（D3、D18）：操作系统的回收站，探测不到就回落到本项目自己管的目录。
// 平台代码只待在这一层：Windows 走外壳接口，Linux 走 freedesktop 的 Trash 规范，macOS 没有后端。
// 探测结果在一次运行里只算一次，它是一条平台事实，运行期间不会变。
import { spawn } from 'node:child_process';
import { access, constants, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { KernelError } from './error.js';

// 交给 powershell 的目标路径走环境变量，不拼进命令文本：路径里带引号或分号也构不成第二条命令。
const SEND_COMMAND = [
  'Add-Type -AssemblyName Microsoft.VisualBasic',
  '$target = $env:LIGULE_TRASH_TARGET',
  'if (Test-Path -LiteralPath $target -PathType Container) {',
  "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  '} else {',
  "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  '}',
].join(' ');

// 探测只确认 powershell 与那个外壳类型都在，不删任何东西：探测不该在用户的回收站里留下痕迹。
const PROBE_COMMAND = 'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem] | Out-Null';

function runPowershell(command, env) {
  return new Promise((resolve, reject) => {
    // stdout 也接成 ignore：这条命令不往标准输出写东西，但一旦写了而没人读，管道满了子进程就永远等在这里。
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new KernelError('recycle_backend_failed', { cause: error })));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new KernelError('recycle_backend_failed', { detail: stderr.trim() || `powershell exited with ${code}` }));
    });
  });
}

export const windowsRecycleBin = {
  name: 'system recycle bin',
  async probe() {
    return runPowershell(PROBE_COMMAND);
  },
  send(target) {
    return runPowershell(SEND_COMMAND, { LIGULE_TRASH_TARGET: target });
  },
};

function trashRoot() {
  const data = process.env.XDG_DATA_HOME;
  return join(typeof data === 'string' && data !== '' ? data : join(homedir(), '.local', 'share'), 'Trash');
}

// freedesktop 的 Trash 规范：内容进 files/，同名的一份 .trashinfo 进 info/，
// 里面写原路径（百分号编码）与删除时间，还原靠的就是这两项。
export const freedesktopTrash = {
  name: 'freedesktop trash',
  async probe() {
    const root = trashRoot();
    await mkdir(join(root, 'files'), { recursive: true });
    await mkdir(join(root, 'info'), { recursive: true });
    await access(join(root, 'files'), constants.W_OK);
  },
  async send(target) {
    const root = trashRoot();
    const files = join(root, 'files');
    const base = basename(target);
    const info = `[Trash Info]\nPath=${encodeTrashPath(target)}\nDeletionDate=${deletionDate(new Date())}\n`;
    // ponytail: 名字是先看一眼有没有、再独占建信息文件来占住的；检查与改名之间仍有一个窗口，
    // 别的程序正好在那一刻放进同一个文件就会撞上。上限是这条，升级路线是先建一个空的同名硬链接占位再改名。
    for (let attempt = 0; ; attempt += 1) {
      const name = attempt === 0 ? base : `${base}.${attempt}`;
      const infoPath = join(root, 'info', `${name}.trashinfo`);
      if (await exists(join(files, name))) continue;
      try {
        // 独占创建：两次删除同时挑中同一个名字时，只有一个能建出这份信息文件，另一个往后加计数。
        await writeFile(infoPath, info, { flag: 'wx' });
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw new KernelError('recycle_backend_failed', { cause: error });
      }
      try {
        await rename(target, join(files, name));
      } catch (error) {
        // 移不进去就把占名的信息文件删掉：留着它就是回收站里一个没有内容的条目。
        // 这里删不掉也不上报，移动失败才是调用方要看的那一条。
        try {
          await rm(infoPath, { force: true });
        } catch {}
        // 回收站与目标不在同一个文件系统上时 rename 报 EXDEV：规范要求那种情况用挂载点自己的回收站，
        // 本实现不做那一层，交回给调用方回落到项目内那个目录。
        if (error.code === 'EXDEV') throw new KernelError('recycle_cross_device', { cause: error });
        throw new KernelError('recycle_backend_failed', { cause: error });
      }
      return;
    }
  },
};

// 规范要的是本地时间的 YYYY-MM-DDThh:mm:ss：截一刀 ISO 串得到的是 UTC，
// 还原界面按本地时间去读就把删除时间报差了几个小时。
function deletionDate(now) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// 规范里的 Path 是百分号编码的绝对路径，分隔符本身不编码。
function encodeTrashPath(target) {
  return target.split('/').map(encodeURIComponent).join('/');
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const CANDIDATES = { win32: windowsRecycleBin, linux: freedesktopTrash };

let resolved;

// 按平台取那一个候选并探测它。探测不通过就没有系统回收站可用，调用方回落到自己管的目录；
// 探测结果里的码交给调用方去记日志，不在这里静默吞掉（I8）。
// 只有本机那一个平台的结果会记下来：探测要起一个进程，每次删除都探一遍太贵。
export async function resolveRecycler(platform = process.platform) {
  if (platform === process.platform && resolved !== undefined) return resolved;
  const result = await resolveOnce(platform);
  if (platform === process.platform) resolved = result;
  return result;
}

async function resolveOnce(platform) {
  const candidate = CANDIDATES[platform];
  if (candidate === undefined) return { recycler: undefined, code: 'recycle_backend_missing' };
  try {
    await candidate.probe();
    return { recycler: candidate };
  } catch (error) {
    return { recycler: undefined, code: error.code ?? 'recycle_probe_failed' };
  }
}
