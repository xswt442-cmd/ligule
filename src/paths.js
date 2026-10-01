// 内核提供边界解析：把模型交来的路径解析成边界内的绝对路径（部件一节的内核判定链与能力提供者）。
// 两类越界都拒绝：路径字符串里的上级引用越界，以及符号链接或硬链接指向边界之外（architecture.md 验证清单第 5 条）。
// 这里只做判断，不做约束：真正的文件与进程约束由能力提供者的后端负责（D18）。
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { KernelError } from './error.js';

const UP = `..${sep}`;

// 词法上的包含判断。用 `..` 加分隔符而不是 `..` 开头，否则边界内一个叫 `..backup` 的目录会被误拒。
export function isWithin(boundary, target) {
  const relativePath = relative(boundary, target);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(UP) && !isAbsolute(relativePath));
}

// 目标还不存在时（写一个新文件），解析最近一层存在的祖先再拼回去：
// 只判词法的话，一个指向边界之外的符号链接父目录会让写入落在边界之外。
async function resolveReal(absolute) {
  try {
    return await realpath(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new KernelError('path_resolve_failed', { cause: error });
    const missing = [];
    let ancestor = absolute;
    while (true) {
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
      if (ancestor === dirname(ancestor)) throw new KernelError('path_parent_missing');
      try {
        const realAncestor = await realpath(ancestor);
        // Windows 上对一个普通文件取 realpath 会成功，POSIX 报 ENOTDIR；父段是文件时目标既不存在也建不出来。
        if (!(await stat(realAncestor)).isDirectory()) throw new KernelError('path_parent_not_directory');
        return resolve(realAncestor, ...missing);
      } catch (cause) {
        if (cause instanceof KernelError) throw cause;
        if (cause.code === 'ENOTDIR') throw new KernelError('path_parent_not_directory', { cause });
        if (cause.code !== 'ENOENT') throw new KernelError('path_resolve_failed', { cause });
      }
    }
  }
}

// 边界本身不存在是配置错了，报它自己的码：交给上层的话只剩一个看不出来源的 ENOENT。
async function realBoundaryOf(boundary) {
  try {
    return await realpath(boundary);
  } catch (error) {
    if (error.code === 'ENOENT') throw new KernelError('boundary_missing', { detail: boundary });
    throw new KernelError('path_resolve_failed', { cause: error });
  }
}

// options.forWrite 为真时，一个有多余链接计数的现有文件也被拒绝：写穿它等于写到边界之外那个同名文件上。
export async function resolveWithin(boundary, path, { forWrite = false } = {}) {
  if (typeof boundary !== 'string' || boundary === '') throw new KernelError('boundary_required');
  if (typeof path !== 'string' || path.trim() === '') throw new KernelError('path_required');
  const absolute = resolve(boundary, path);
  if (!isWithin(boundary, absolute)) throw new KernelError('path_escapes_boundary');

  const realBoundary = await realBoundaryOf(boundary);
  const real = await resolveReal(absolute);
  if (!isWithin(realBoundary, real)) throw new KernelError('path_escapes_through_link');

  if (forWrite) {
    try {
      const info = await stat(real);
      // 链接计数只对普通文件有意义：目录的计数本来就大于 1。
      if (info.isFile() && info.nlink > 1) throw new KernelError('path_hard_linked');
    } catch (error) {
      if (error instanceof KernelError) throw error;
      // 目标还不存在，没有链接计数可查；父段不是目录的情况在 resolveReal 里已经拒过。
      if (error.code !== 'ENOENT') throw new KernelError('path_resolve_failed', { cause: error });
    }
  }
  return real;
}
