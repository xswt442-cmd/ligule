// 终端界面那一栏反查（D81 边界二）：从共用的那一份输入历史里筛出含这一段的那几条。
// 历史文件本身在内核那一侧（`src/kernel/input-history.ts`），桌面与终端读写的都是它。
/** 反查那几行的条数上限：清单超过这个数就挡住输入框本身了。 */
export const SEARCH_ROWS = 8;

/** 反查：含这一段的那些条，从新到旧，重复内容只留一次。空查询不猜，交回空的。 */
export function searchHistory(entries: readonly string[], query: string, limit = SEARCH_ROWS): string[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === '') return [];
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().includes(wanted)) continue;
    if (found.includes(entry)) continue;
    found.push(entry);
    if (found.length >= limit) break;
  }
  return found;
}
