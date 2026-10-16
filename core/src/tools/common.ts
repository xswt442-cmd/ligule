// 文件工具的共享部分：路径的书写形式、截断标记、按路径序遍历边界、存在与类型判断。
// 遍历顺序与两条检索后端的排序规则是同一套：都按路径序交回，同一输入两次运行得到同一份结果。
import { readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { KernelError } from '../kernel/error.js';

export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export function marker(detail: string): string {
  return `\n[${detail}]`;
}

// 深度优先遍历边界内的文件，交出相对边界、用斜杠书写的路径。
// 排序把目录名后面补一个斜杠再比，于是文件与子目录按路径的字典序交错出现：
// `src.txt` 排在 `src/app.js` 前面，与外部后端按路径排序那一条一样。
// 顺序固定下来，同一份文件树两次扫出来的结果与截断时留下的那一截才相同。
// 跳过的目录由调用方给，遍历只负责按上面的顺序走。
export async function* walkFiles(root: string, skipped: readonly string[], directory = root): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (orderKey(left) < orderKey(right) ? -1 : 1));
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skipped.includes(entry.name)) yield* walkFiles(root, skipped, full);
    } else if (entry.isFile()) {
      yield toPosix(relative(root, full));
    }
  }
}

function orderKey(entry: Dirent): string {
  return entry.isDirectory() ? `${entry.name}/` : entry.name;
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export function errorMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('message' in error)) return undefined;
  return typeof error.message === 'string' ? error.message : undefined;
}

export async function readExisting(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') throw new KernelError('path_not_found', { detail: `there is nothing to read at ${path}` });
    throw new KernelError('path_resolve_failed', { cause: error, detail: `reading ${path} failed: ${code ?? errorMessage(error)}` });
  }
}

export async function existsOrFails(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return false;
    throw new KernelError('path_resolve_failed', { cause: error, detail: `checking ${path} failed: ${code ?? errorMessage(error)}` });
  }
}

// 目录还是文件，两种工具都按这个分派；不存在时给一个可以分支的码，而不是让 readdir 与 readFile 抛原始错误。
export async function kindOfTarget(path: string): Promise<'directory' | 'file'> {
  try {
    return (await stat(path)).isDirectory() ? 'directory' : 'file';
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') throw new KernelError('path_not_found', { detail: `there is nothing at ${path}` });
    throw new KernelError('path_resolve_failed', { cause: error, detail: `checking ${path} failed: ${code ?? errorMessage(error)}` });
  }
}
