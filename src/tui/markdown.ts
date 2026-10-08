// markdown 的结构由解析器读取，代码的词法种类由高亮库提供；这一层只负责终端显示。
import { marked, type MarkedToken, type Token } from 'marked';
import highlight, { type Emitter } from 'highlight.js';
import { displayWidth } from './commands.js';

export interface MarkdownSpan {
  readonly text: string;
  readonly scope?: string;
}

export interface MarkdownLine {
  readonly kind: 'heading' | 'list' | 'code' | 'text' | 'table';
  readonly text: string;
  readonly spans?: readonly MarkdownSpan[];
}

class TerminalEmitter implements Emitter {
  readonly spans: MarkdownSpan[] = [];
  private scopes: string[] = [];

  addText(text: string): void {
    if (text !== '') this.spans.push({ text, scope: this.scopes.at(-1) });
  }

  startScope(name: string): void { this.scopes.push(name); }
  endScope(): void { this.scopes.pop(); }
  openNode(name: string): void { this.startScope(name); }
  closeNode(): void { this.endScope(); }
  closeAllNodes(): void { this.finalize(); }
  finalize(): void { this.scopes = []; }
  toHTML(): string { return ''; }

  __addSublanguage(emitter: Emitter, _language: string): void {
    if (!(emitter instanceof TerminalEmitter)) throw new Error('tui_highlight_emitter_invalid');
    this.spans.push(...emitter.spans);
  }
}

const renderer = highlight.newInstance();
for (const name of highlight.listLanguages()) {
  const language = highlight.getLanguage(name);
  if (language !== undefined) renderer.registerLanguage(name, () => language);
}
renderer.configure({ __emitter: TerminalEmitter });

// 强调那几种记号在这一层只带一个范围名，怎么画由界面决定（第 96 步：加粗、斜体、删除线与行内代码）。
// 这一个前缀与 highlight.js 那一套的范围名分开：那两个来源的数字不会撞在一起。
export const EMPHASIS = {
  strong: 'md-strong',
  em: 'md-em',
  del: 'md-del',
  codespan: 'md-codespan',
} as const;

function inline(tokens: readonly Token[]): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  const push = (text: string, scope?: string): void => {
    if (text === '') return;
    const last = spans.at(-1);
    // 挨着同一种范围的两段合成一段：画出来一样，读的人少看几节。
    if (last !== undefined && last.scope === scope) {
      spans[spans.length - 1] = scope === undefined ? { text: last.text + text } : { text: last.text + text, scope };
      return;
    }
    spans.push(scope === undefined ? { text } : { text, scope });
  };
  for (const value of tokens) {
    const token = value as MarkedToken;
    if (token.type === 'codespan') push(token.text, EMPHASIS.codespan);
    else if (token.type === 'escape') push(token.text);
    else if (token.type === 'link' || token.type === 'image') push(`${inlineText(token.tokens)} (${token.href})`);
    else if (token.type === 'strong' || token.type === 'em' || token.type === 'del') {
      const scope = token.type === 'strong' ? EMPHASIS.strong : token.type === 'em' ? EMPHASIS.em : EMPHASIS.del;
      for (const span of inline(token.tokens)) push(span.text, span.scope ?? scope);
    } else if (token.type === 'br') push('\n');
    else if (token.type === 'text') push(token.tokens === undefined ? token.text : inlineText(token.tokens));
    else push(token.raw);
  }
  return spans;
}

function inlineText(tokens: readonly Token[]): string {
  return inline(tokens).map((span) => span.text).join('');
}

// 行首的前缀（缩进、列表的记号、引用那一竖）算这一行的一段，跟着别的段一起画；后面那一段没有范围时并进它。
function prefixed(prefix: string, spans: MarkdownSpan[]): MarkdownSpan[] {
  if (prefix === '') return spans;
  const [first, ...rest] = spans;
  if (first === undefined) return [{ text: prefix }];
  return first.scope === undefined ? [{ text: prefix + first.text }, ...rest] : [{ text: prefix }, ...spans];
}

// 一行只在真有强调或行内代码时带 spans：纯文字那些行保持原样，别的消费者（复制、表格）不必多看一格。
function withSpans(kind: MarkdownLine['kind'], spans: MarkdownSpan[]): MarkdownLine {
  const text = spans.map((span) => span.text).join('');
  return spans.some((span) => span.scope !== undefined) ? { kind, text, spans } : { kind, text };
}

function codeLines(text: string, language?: string): MarkdownLine[] {
  const name = language?.split(/\s+/)[0];
  if (name === undefined || renderer.getLanguage(name) === undefined) {
    return text.split('\n').map((line) => ({ kind: 'code', text: line }));
  }
  const result = renderer.highlight(text, { language: name, ignoreIllegals: true });
  if (result.errorRaised !== undefined) throw result.errorRaised;
  if (!(result._emitter instanceof TerminalEmitter)) throw new Error('tui_highlight_emitter_invalid');
  const rows: MarkdownSpan[][] = [[]];
  for (const span of result._emitter.spans) {
    for (const [index, part] of span.text.split('\n').entries()) {
      if (index > 0) rows.push([]);
      if (part !== '') rows[rows.length - 1].push({ text: part, scope: span.scope });
    }
  }
  return rows.map((spans) => ({ kind: 'code', text: spans.map((span) => span.text).join(''), spans }));
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function wrapCell(text: string, width: number): string[] {
  const lines = [''];
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const last = lines.length - 1;
    if (segment === '\n') { lines.push(''); used = 0; continue; }
    const size = displayWidth(segment);
    if (used + size > width && lines[last] !== '') { lines.push(segment); used = size; }
    else { lines[last] += segment; used += size; }
  }
  return lines;
}

export function markdownLines(text: string, columns = 80): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  function blocks(tokens: readonly Token[], prefix = ''): void {
    for (const value of tokens) {
      const token = value as MarkedToken;
      if (token.type === 'code') {
        lines.push(...codeLines(token.text, token.lang).map((line) => ({ ...line, text: prefix + line.text })));
      } else if (token.type === 'heading') {
        lines.push(withSpans('heading', prefixed(prefix, inline(token.tokens))));
      } else if (token.type === 'list') {
        for (const [index, item] of token.items.entries()) {
          const marker = token.ordered ? `${Number(token.start) + index}. ` : '· ';
          const task = item.task ? `[${item.checked === true ? 'x' : ' '}] ` : '';
          const spans = prefixed(prefix + marker + task, inline(item.tokens.flatMap((part) => (part as { tokens?: Token[] }).tokens ?? [part])));
          // 列表那一行收尾的空格不进 spans：行尾的空白画出来看不见，留在文字里才是原来那一行。
          const trimmed = withSpans('list', spans);
          lines.push({ ...trimmed, text: trimmed.text.trimEnd() });
        }
      } else if (token.type === 'blockquote') {
        blocks(token.tokens, prefix + '│ ');
      } else if (token.type === 'table') {
        const rows = [token.header, ...token.rows].map((row) => row.map((cell) => inlineText(cell.tokens)));
        const count = token.header.length;
        const budget = Math.max(count, columns - displayWidth(prefix) - 3 * count - 1);
        const widths = token.header.map((_, index) => Math.max(1, ...rows.map((row) => displayWidth(row[index] ?? ''))));
        while (widths.reduce((sum, width) => sum + width, 0) > budget) {
          const widest = widths.indexOf(Math.max(...widths));
          widths[widest] -= 1;
        }
        const border = `${prefix}┼${widths.map((width) => '─'.repeat(width + 2)).join('┼')}┼`;
        for (const [index, row] of rows.entries()) {
          const cells = widths.map((width, column) => wrapCell(row[column] ?? '', width));
          const height = Math.max(...cells.map((cell) => cell.length));
          for (let line = 0; line < height; line += 1) {
            lines.push({ kind: 'table', text: `${prefix}│ ${cells.map((cell, column) => {
              const content = cell[line] ?? '';
              return content + ' '.repeat(Math.max(0, widths[column] - displayWidth(content)));
            }).join(' │ ')} │` });
          }
          if (index === 0) lines.push({ kind: 'table', text: border });
        }
      } else if (token.type === 'paragraph' || token.type === 'text') {
        const spans = token.tokens === undefined ? [{ text: token.text }] : inline(token.tokens);
        const line = withSpans('text', prefixed(prefix, spans));
        lines.push(...line.text.split('\n').map((part, index) => (index === 0 ? { ...line, text: part } : { kind: 'text' as const, text: part })));
      } else if (token.type === 'space') {
        if (lines.length > 0 && lines.at(-1)?.text !== '') lines.push({ kind: 'text', text: '' });
      } else if (token.type === 'hr') {
        lines.push({ kind: 'text', text: prefix + '─'.repeat(Math.min(24, columns)) });
      } else if (token.type !== 'def') {
        lines.push({ kind: 'text', text: prefix + token.raw });
      }
    }
  }
  blocks(marked.lexer(text, { gfm: true }));
  while (lines.at(-1)?.text === '') lines.pop();
  return lines;
}
