// 文件工具共用路径处理、截断标记、边界遍历、存在性和类型检查。
// 目录遍历按路径排序，确保重复查询返回稳定顺序。
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

// 深度优先遍历边界内的文件，并返回相对路径和正斜杠分隔符。
// 目录路径排序时补上尾斜杠，使文件和子目录按路径字典序交错排列。
// 稳定顺序也确保结果截断时每次保留相同文件。
// 排除目录由调用方提供。
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

// 统一检查目标是文件还是目录；路径不存在时返回稳定错误码，不传递原始 `readdir` 或 `readFile` 错误。
export async function kindOfTarget(path: string): Promise<'directory' | 'file'> {
  try {
    return (await stat(path)).isDirectory() ? 'directory' : 'file';
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') throw new KernelError('path_not_found', { detail: `there is nothing at ${path}` });
    throw new KernelError('path_resolve_failed', { cause: error, detail: `checking ${path} failed: ${code ?? errorMessage(error)}` });
  }
}
