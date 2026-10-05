// 把端点交回来的 markdown 文本切成「行形状」：标题、列表、围栏代码、正文四种（第 41 步、D81）。
// 这一层只分行，不做语法高亮，也不解析表格——要不要引一条解析库还没定（U46），未定之前不新增依赖。

export type MarkdownKind = 'heading' | 'list' | 'code' | 'text';

export interface MarkdownLine {
  readonly kind: MarkdownKind;
  readonly text: string;
}

const FENCE = /^\s*```/;
const HEADING = /^#{1,4}\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

// 行内那几种写法在终端里没有对应字形：链接留下文字与地址，加粗与行内代码只留文字。
// 只动这几种，其余字符原样过去：代码片段里的一对星号被吃掉就是错的内容。
function inline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g, (_all, label: string, url: string) => (label === '' ? url : `${label} (${url})`))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

export function markdownLines(text: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let inside = false;
  for (const raw of text.split('\n')) {
    if (FENCE.test(raw)) {
      inside = !inside;
      continue;
    }
    // 围栏里的每一行原样保留：缩进、尾随空格与 `#` 都是内容的一部分。
    if (inside) {
      lines.push({ kind: 'code', text: raw });
      continue;
    }
    if (raw.trim() === '') {
      lines.push({ kind: 'text', text: '' });
      continue;
    }
    const heading = HEADING.exec(raw.trimStart());
    if (heading !== null) {
      lines.push({ kind: 'heading', text: inline(heading[1].replace(/\s+$/, '')) });
      continue;
    }
    const bullet = BULLET.exec(raw) ?? NUMBERED.exec(raw);
    if (bullet !== null) {
      lines.push({ kind: 'list', text: inline(bullet[1].replace(/\s+$/, '')) });
      continue;
    }
    lines.push({ kind: 'text', text: inline(raw) });
  }
  // 结尾那几行空白不画：一段回答后面留一行空气，屏幕下方就多一行没有内容的行。
  while (lines.length > 0 && lines[lines.length - 1].kind === 'text' && lines[lines.length - 1].text === '') {
    lines.pop();
  }
  return lines;
}
