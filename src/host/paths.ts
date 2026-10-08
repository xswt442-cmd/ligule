// 界面上 `@` 要的候选文件从这一处来：宿主读目录，界面不开盘（D81 边界一、方案 5.3）。
// 走的是文件工具那一份遍历（`src/tools/common.js` 的 `walkFiles`），所以候选的先后与模型自己列目录时看到的是同一套顺序。
// 符号链接不进候选也不跟：`walkFiles` 只认普通文件与目录，指向边界之外的链接因此天然扩大不了可见范围。
import { KernelError } from '../kernel/error.js';
import { walkFiles } from '../tools/common.js';

/** 一次交回的候选条数上限。 */
export const PATH_LIMIT = 20;
/** 一次最多看多少个文件就停：找不到就算了，不让人等整棵仓库。 */
const VISIT_BUDGET = 4000;
// 这两处通常最大，也不是人要引用的东西；跳掉它们把预算留给真正的项目文件。
const SKIPPED = ['.git', 'node_modules', 'dist', '.ligule/sessions'];

export type PathListing = { projectRoot: string; paths: string[]; visited: number; stopped: '' | 'budget' | 'unreadable' };

/**
 * 在项目根内找整条相对路径里含这一段文字的那些条。
 * 文字为空就是列出最靠前的几条，不是拒掉——按下 `@` 时人正是要看有什么。
 * `budget` 是这一处那一个上限，只为检查留的口：真用法都是默认的 4000。
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
      // 读不了的那一层不算这次查询失败：已经找到的那些条照样有用，只是不保证找全。
      if (found.length === 0 && visited === 0) throw new KernelError('paths_root_unreadable', { cause: error, detail: `${boundary}: ${(error as Error).message}` });
      stopped = 'unreadable';
      break;
    }
    if (next.done === true) { finished = true; break; }
    visited += 1;
    if (wanted === '' || next.value.toLowerCase().includes(wanted)) found.push(next.value);
  }
  // 翻到上限就停手时，「没有对得上的」这一句不能说得像查过每一层：一条没找到也要说可能没找全。
  if (stopped === '' && !finished && visited >= budget) stopped = 'budget';
  return { projectRoot: boundary, paths: found, visited, stopped };
}
