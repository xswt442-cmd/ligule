// `@` 路径引用的识别和替换规则。TUI 使用相同规则的独立实现。
// 这些纯函数不依赖渲染，可单独验证。
export type MentionToken = { start: number; text: string };

const MENTION = /(?:^|\s)@([^\s]*)$/;

/** 查找光标前尚未完成的路径引用；光标位于文本中间时不匹配，避免截断已有内容。 */
export function mentionToken(draft: string, caret: number): MentionToken | null {
  const after = draft.slice(caret);
  if (after !== '' && !/^\s/.test(after)) return null;
  const matched = MENTION.exec(draft.slice(0, caret));
  if (matched === null) return null;
  return { start: caret - matched[1].length - 1, text: matched[1] };
}

/** 选择候选后替换当前 `@…` 文本为 `@路径 `，并保留其后的草稿内容。 */
export function insertMention(draft: string, caret: number, start: number, path: string): { draft: string; caret: number } {
  const inserted = `@${path} `;
  return { draft: draft.slice(0, start) + inserted + draft.slice(caret), caret: start + inserted.length };
}
