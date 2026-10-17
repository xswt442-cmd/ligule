// 删除内容优先移入操作系统回收站；系统功能不可用时使用项目管理的回收目录。
// 平台实现集中在此处：Windows 使用系统接口，Linux 遵循 FreeDesktop Trash 规范，macOS 暂无系统后端。
// 每个进程只探测一次系统回收站能力。
import { spawn } from 'node:child_process';
import { access, constants, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { KernelError } from '../kernel/error.js';

type RecycleBackend = {
  name: string;
  probe: () => Promise<void>;
  send: (target: string) => Promise<void>;
};
type RecyclerResolution =
  | { recycler: RecycleBackend }
  | { recycler: undefined; code: string };

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') return undefined;
  return error.code;
}

function errorMessage(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'message' in error ? error.message : undefined;
}

// 通过环境变量将目标路径传给 PowerShell，避免引号或分号被解释为额外命令。
const SEND_COMMAND = [
  'Add-Type -AssemblyName Microsoft.VisualBasic',
  '$target = $env:LIGULE_TRASH_TARGET',
  'if (Test-Path -LiteralPath $target -PathType Container) {',
  "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  '} else {',
  "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  '}',
].join(' ');

// 探测只验证 PowerShell 和系统回收站接口可用，不执行删除操作。
const PROBE_COMMAND = 'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem] | Out-Null';

function runPowershell(command: string, env?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    // 丢弃 stdout，避免子进程写满管道后阻塞。
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new KernelError('recycle_backend_failed', { cause: error, detail: `powershell could not be started to move the file to the recycle bin: ${errorCode(error) ?? errorMessage(error)}` })));
    child.on('close', (code: number | null) => {
      if (code === 0) resolve();
      else reject(new KernelError('recycle_backend_failed', { detail: stderr.trim() || `powershell exited with ${code}` }));
    });
  });
}

export const windowsRecycleBin = {
  name: 'system recycle bin',
  async probe(): Promise<void> {
    return runPowershell(PROBE_COMMAND);
  },
  send(target: string): Promise<void> {
    return runPowershell(SEND_COMMAND, { LIGULE_TRASH_TARGET: target });
  },
};

function trashRoot(): string {
  const data = process.env.XDG_DATA_HOME;
  return join(typeof data === 'string' && data !== '' ? data : join(homedir(), '.local', 'share'), 'Trash');
}

// FreeDesktop Trash 将内容写入 `files/`，并在 `info/` 中保存对应的 `.trashinfo` 文件。
// 元数据记录百分号编码的原路径和删除时间，供还原时使用。
export const freedesktopTrash = {
  name: 'freedesktop trash',
  async probe(): Promise<void> {
    const root = trashRoot();
    await mkdir(join(root, 'files'), { recursive: true });
    await mkdir(join(root, 'info'), { recursive: true });
    await access(join(root, 'files'), constants.W_OK);
  },
  async send(target: string): Promise<void> {
    const root = trashRoot();
    const files = join(root, 'files');
    const base = basename(target);
    const info = `[Trash Info]\nPath=${encodeTrashPath(target)}\nDeletionDate=${deletionDate(new Date())}\n`;
    // 先检查目标名称，再独占创建元数据文件；如果其他程序同时占用该名称，则尝试下一个名称。
    for (let attempt = 0; ; attempt += 1) {
      const name = attempt === 0 ? base : `${base}.${attempt}`;
      const infoPath = join(root, 'info', `${name}.trashinfo`);
      if (await exists(join(files, name))) continue;
      try {
        // 使用独占创建处理并发删除；冲突时递增名称后缀并重试。
        await writeFile(infoPath, info, { flag: 'wx' });
      } catch (error) {
        const code = errorCode(error);
        if (code === 'EEXIST') continue;
        throw new KernelError('recycle_backend_failed', { cause: error, detail: `the trash could not claim a name for ${target}: ${code ?? errorMessage(error)}` });
      }
      try {
        await rename(target, join(files, name));
      } catch (error) {
        // 移动失败时清理已创建的元数据文件，避免留下无内容的回收站条目。
        try {
          await rm(infoPath, { force: true });
        } catch {}
        // 跨文件系统重命名会返回 EXDEV；此实现不处理挂载点回收站，交由调用方使用项目回收目录。
        const code = errorCode(error);
        if (code === 'EXDEV') {
          throw new KernelError('recycle_cross_device', { cause: error, detail: `${target} and the trash are on different filesystems` });
        }
        throw new KernelError('recycle_backend_failed', { cause: error, detail: `the trash refused ${target}: ${code ?? errorMessage(error)}` });
      }
      return;
    }
  },
};

// 按规范使用本地时间格式 `YYYY-MM-DDThh:mm:ss`，避免将 UTC 时间误显示为本地删除时间。
function deletionDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// 元数据中的 Path 使用百分号编码的绝对路径，路径分隔符保持原样。
function encodeTrashPath(target: string): string {
  return target.split('/').map(encodeURIComponent).join('/');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const CANDIDATES: Partial<Record<NodeJS.Platform, RecycleBackend>> = { win32: windowsRecycleBin, linux: freedesktopTrash };

let resolved: RecyclerResolution | undefined;

// 选择当前平台的回收站后端并探测可用性；不可用时由调用方使用项目回收目录。
// 返回探测错误供调用方记录日志。每个进程只缓存当前平台的探测结果。
export async function resolveRecycler(platform: NodeJS.Platform = process.platform): Promise<RecyclerResolution> {
  if (platform === process.platform && resolved !== undefined) return resolved;
  const result = await resolveOnce(platform);
  if (platform === process.platform) resolved = result;
  return result;
}

async function resolveOnce(platform: NodeJS.Platform): Promise<RecyclerResolution> {
  const candidate = CANDIDATES[platform];
  if (candidate === undefined) return { recycler: undefined, code: 'recycle_backend_missing' };
  try {
    await candidate.probe();
    return { recycler: candidate };
  } catch (error) {
    return { recycler: undefined, code: errorCode(error) ?? 'recycle_probe_failed' };
  }
}
