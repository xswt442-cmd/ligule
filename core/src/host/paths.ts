// Host 为界面的 `@` 文件引用提供候选项，前端不直接扫描磁盘。
// 复用 `core/src/tools/common.ts` 的 `walkFiles`，确保搜索顺序与文件工具一致。
// 不跟随符号链接，避免暴露项目边界之外的路径。
import { KernelError } from '../kernel/error.js';
import { walkFiles } from '../tools/common.js';

/** 单次返回的路径候选数量上限。 */
export const PATH_LIMIT = 20;
/** 单次最多扫描的文件数，避免遍历过大的项目目录。 */
const VISIT_BUDGET = 4000;
// 跳过通常体积较大且不适合作为引用目标的目录，将扫描预算留给项目文件。
const SKIPPED = ['.git', 'node_modules', 'dist', '.ligule/sessions'];

export type PathListing = { projectRoot: string; paths: string[]; visited: number; stopped: '' | 'budget' | 'unreadable' };

/**
 * 在项目根内查找相对路径中包含指定文本的文件。
 * 空查询时返回优先级最高的候选，用于用户刚输入 `@` 时展示。
 * `budget` 用于限定扫描范围。
 */
export async function listProjectFiles(boundary: string, query: string, limit = PATH_LIMIT, budget = VISIT_BUDGET): Promise<PathListing> {
  const wanted = query.trim().toLowerCase();
  const found: string[] = [];
  let visited = 0;
  let stopped: PathListing['stopped'] = '';
  let finished = false;
  const walker = walkFiles(boundary, SKIPPED)[Symbol.asyncIterator]();
  while (visited < budget && found.length < limit) {
    let next: IteratorResult<string>;
    try {
      next = await walker.next();
    } catch (error) {
      // 目录读取失败时保留已有结果，并标记扫描可能不完整。
      if (found.length === 0 && visited === 0) throw new KernelError('paths_root_unreadable', { cause: error, detail: `${boundary}: ${(error as Error).message}` });
      stopped = 'unreadable';
      break;
    }
    if (next.done === true) { finished = true; break; }
    visited += 1;
    if (wanted === '' || next.value.toLowerCase().includes(wanted)) found.push(next.value);
  }
  // 达到扫描上限时标记结果可能不完整，避免将未扫描误报为没有匹配项。
  if (stopped === '' && !finished && visited >= budget) stopped = 'budget';
  return { projectRoot: boundary, paths: found, visited, stopped };
}
