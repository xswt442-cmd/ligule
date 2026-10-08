// `@` 那一段路径引用：认出来与换进去的两格判断（方案 5.3）。终端那一侧是同一条规则，各自一份实现。
// 与界面渲染无关，所以那两份断言跑在 `dev/hotkeys.check.mjs` 里。
export type MentionToken = { start: number; text: string };

const MENTION = /(?:^|\s)@([^\s]*)$/;

/** 落笔处往回找那一个还没写完的路径引用；笔落在一段中间时不算，那会截断人已写好的那一段。 */
export function mentionToken(draft: string, caret: number): MentionToken | null {
  const after = draft.slice(caret);
  if (after !== '' && !/^\s/.test(after)) return null;
  const matched = MENTION.exec(draft.slice(0, caret));
  if (matched === null) return null;
  return { start: caret - matched[1].length - 1, text: matched[1] };
}

/** 选中一条候选后的草稿与落笔处：那一段 `@…` 换成 `@路径␣`，后面已写的字保留。 */
export function insertMention(draft: string, caret: number, start: number, path: string): { draft: string; caret: number } {
  const inserted = `@${path} `;
  return { draft: draft.slice(0, start) + inserted + draft.slice(caret), caret: start + inserted.length };
}
