// TUI 在共享输入历史中执行反向搜索。
// 历史文件由 Host 的 `core/src/kernel/input-history.ts` 管理，Desktop 和 TUI 共用。
/** 限制反向搜索结果数，避免列表遮挡输入框。 */
export const SEARCH_ROWS = 8;

/** 按新到旧搜索包含查询文本的历史项，并移除重复项；空查询返回空列表。 */
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
