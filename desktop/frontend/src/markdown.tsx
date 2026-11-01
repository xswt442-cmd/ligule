// 使用 `marked` 解析 Markdown 标记，再由本组件映射为 React 元素。
// 不渲染 `marked.parse` 返回的 HTML，避免模型输出的标签被浏览器执行。
// 代码围栏仅显示经 `highlight.js` 处理并转义的代码文本。
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Lexer, type Token, type Tokens } from 'marked';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import { useText } from './locale';
import 'highlight.js/styles/github-dark.min.css';

const inlineLexer = new Lexer({ gfm: true, breaks: false });

function highlight(code: string, language: string | undefined): string {
  const lang = language === undefined || language === '' ? 'plaintext' : language;
  if (hljs.getLanguage(lang) === undefined) return escapeHtml(code);
  // 高亮失败时保留原始代码文本。
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}

// 支持加粗、斜体、删除线、行内代码、链接和换行；链接仅允许 http(s) 与 mailto 协议。
function inline(nodes: Token[] | string, key: string): ReactNode[] {
  const tokens = typeof nodes === 'string' ? inlineLexer.inlineTokens(nodes) : nodes;
  return tokens.map((token, index) => renderInline(token, `${key}:${index}`));
}

function renderInline(token: Token, key: string): ReactNode {
  const at = (token as { text?: string; href?: string; title?: string; children?: Token[]; type?: string });
  switch (token.type) {
    case 'strong': return <strong key={key}>{inline(at.children ?? at.text ?? '', key)}</strong>;
    case 'em': return <em key={key}>{inline(at.children ?? at.text ?? '', key)}</em>;
    case 'del': return <del key={key}>{inline(at.children ?? at.text ?? '', key)}</del>;
    case 'codespan': return <code key={key} className="inline-code">{at.text}</code>;
    case 'br': return <br key={key} />;
    case 'escape': return <span key={key}>{at.text}</span>;
    case 'link': {
      const href = safeHref(at.href ?? '');
      const body = inline(at.children ?? at.text ?? '', key);
      if (href === '') return <span key={key}>{body}</span>;
      return <a key={key} href={href} title={at.title} target="_blank" rel="noreferrer noopener">{body}</a>;
    }
    // 将行内 HTML 标记作为普通文本显示，不执行模型生成的标签。
    default: return <span key={key}>{typeof (token as { raw?: string }).raw === 'string' ? (token as { raw: string }).raw : ''}</span>;
  }
}

function safeHref(href: string): string {
  const [scheme] = href.split(':');
  return /^(https?|mailto)$/i.test(scheme) ? href : '';
}

// 复制代码围栏中的原始文本，不复制高亮后的展示内容。
// 使用 Chromium 提供的 `navigator.clipboard`；复制成功或失败时都显示明确结果。
function CodeBlock({ code }: { code: Tokens.Code }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const t = useText();
  return <div className="md-code-wrap">
    <pre className="md-code" data-lang={code.lang ?? ''}><code className="hljs" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(highlight(code.text, code.lang), { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] }) }} /></pre>
    <p className="code-copy-row">
      <button type="button" className="code-copy" onClick={() => {
        void navigator.clipboard.writeText(code.text).then(
          () => setCopyState('copied'),
          () => setCopyState('failed'),
        );
      }}>{t('复制代码', 'Copy code')}</button>
      {copyState !== 'idle' && <span className="row-note">{copyState === 'copied'
        ? t(`已复制代码（${code.text.length} 个字符）`, `Copied code (${code.text.length} characters)`)
        : t('复制失败：当前界面无法访问剪贴板。', 'Copy failed: this interface cannot access the clipboard.')}</span>}
    </p>
  </div>;
}

function block(tokens: Token[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  tokens.forEach((token, index) => {
    const at = token as Record<string, unknown> as { text?: string; raw?: string };
    const id = `${key}:${index}`;
    if (token.type === 'space') return;
    if (token.type === 'heading') {
      const depth = (at as Tokens.Heading).depth;
      const body = inline((at as Tokens.Heading).tokens ?? (at as Tokens.Heading).text, id);
      const Tag = (`h${Math.min(6, Math.max(1, depth))}`) as 'h1';
      out.push(<Tag key={id} className={`md-h md-h${depth}`}>{body}</Tag>);
      return;
    }
    if (token.type === 'paragraph') {
      out.push(<p key={id}>{inline((at as Tokens.Paragraph).tokens ?? (at as Tokens.Paragraph).text, id)}</p>);
      return;
    }
    if (token.type === 'code') {
      out.push(<CodeBlock key={id} code={at as Tokens.Code} />);
      return;
    }
    if (token.type === 'list') {
      const list = at as Tokens.List;
      const items = list.items.map((item, itemIndex) => <li key={`${id}:${itemIndex}`}>{block(item.tokens ?? [], `${id}:${itemIndex}`)}</li>);
      out.push(list.ordered
        ? <ol key={id} start={typeof list.start === 'number' ? list.start : undefined}>{items}</ol>
        : <ul key={id}>{items}</ul>);
      return;
    }
    if (token.type === 'table') {
      const table = at as Tokens.Table;
      const head = (cell: Tokens.TableCell, cellKey: string) => <td key={cellKey}>{inline(cell.tokens ?? [], cellKey)}</td>;
      out.push(<table key={id} className="md-table">
        <thead><tr>{table.header.map((cell, i) => <th key={`${id}:h${i}`}>{inline(cell.tokens ?? '', `${id}:h${i}`)}</th>)}</tr></thead>
        <tbody>{table.rows.map((row, r) => <tr key={`${id}:r${r}`}>{row.map((cell, c) => head(cell, `${id}:r${r}c${c}`))}</tr>)}</tbody>
      </table>);
      return;
    }
    if (token.type === 'blockquote') {
      out.push(<blockquote key={id}>{block((at as Tokens.Blockquote).tokens ?? [], id)}</blockquote>);
      return;
    }
    if (token.type === 'hr') {
      out.push(<hr key={id} />);
      return;
    }
    if (token.type === 'def') return;
    // 未支持的标记（包括 HTML 块）按原文显示，不执行其中内容。
    out.push(<p key={id}>{(at as { raw?: string; text?: string }).raw ?? (at as { text?: string }).text ?? ''}</p>);
  });
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lexer = new Lexer({ gfm: true, breaks: false });
  return <div className="markdown">{block(lexer.lex(text), 'md')}</div>;
}
