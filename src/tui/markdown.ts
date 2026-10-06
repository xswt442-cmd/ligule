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

function inline(tokens: readonly Token[]): string {
  return tokens.map((value) => {
    const token = value as MarkedToken;
    if (token.type === 'codespan' || token.type === 'escape') return token.text;
    if (token.type === 'link' || token.type === 'image') return `${inline(token.tokens)} (${token.href})`;
    if (token.type === 'strong' || token.type === 'em' || token.type === 'del') return inline(token.tokens);
    if (token.type === 'br') return '\n';
    if (token.type === 'text') return token.tokens === undefined ? token.text : inline(token.tokens);
    return token.raw;
  }).join('');
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
        lines.push({ kind: 'heading', text: prefix + inline(token.tokens) });
      } else if (token.type === 'list') {
        for (const [index, item] of token.items.entries()) {
          const content = inline(item.tokens.flatMap((part) => (part as { tokens?: Token[] }).tokens ?? [part]));
          const marker = token.ordered ? `${Number(token.start) + index}. ` : '· ';
          const task = item.task ? `[${item.checked === true ? 'x' : ' '}] ` : '';
          lines.push({ kind: 'list', text: prefix + marker + task + content.trimEnd() });
        }
      } else if (token.type === 'blockquote') {
        blocks(token.tokens, prefix + '│ ');
      } else if (token.type === 'table') {
        const rows = [token.header, ...token.rows].map((row) => row.map((cell) => inline(cell.tokens)));
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
        const content = token.tokens === undefined ? token.text : inline(token.tokens);
        lines.push(...content.split('\n').map((line) => ({ kind: 'text' as const, text: prefix + line })));
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
