// 头部与正文的分界只切一次：技能与提示模板用同一种 YAML frontmatter（D49），
// 各自的字段与上限由各自的 schema 判，这里只管「哪一段是头部」。
const OPENING = /^---[ \t]*\r?\n/;
const CLOSING = /^---[ \t]*$/m;

export interface DocumentParts {
  head: string | undefined;
  body: string;
}

export function splitFrontmatter(text: string): DocumentParts {
  const opening = text.match(OPENING);
  if (opening?.index !== 0) return { head: undefined, body: text };
  const rest = text.slice(opening[0].length);
  const closing = rest.match(CLOSING);
  if (closing?.index === undefined) return { head: undefined, body: text };
  return { head: rest.slice(0, closing.index), body: rest.slice(closing.index + closing[0].length).replace(/^[ \t]*\r?\n/, '') };
}
