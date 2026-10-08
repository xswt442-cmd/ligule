// 助手那一段的 Markdown 画法（D89）。走 `marked` 的词法拿记号，记号由这里映射成元素：
// 不吃 `marked.parse` 交回的 HTML 串，模型写的成对尖括号因此不会变成可执行的标签。
// 唯一接受 HTML 串的位置是代码围栏：`highlight.js` 输出的那一段只含它自己生成的类名与转义后的文本。
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Lexer, type Token, type Tokens } from 'marked';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github-dark.min.css';

const inlineLexer = new Lexer({ gfm: true, breaks: false });

function highlight(code: string, language: string | undefined): string {
  const lang = language === undefined || language === '' ? 'plaintext' : language;
  if (hljs.getLanguage(lang) === undefined) return escapeHtml(code);
  // 上色失败不能把整段代码弄丢：读不懂的语言就按原文画。
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}

// 行内那几种记号：加粗、斜体、删除线、行内代码、链接、换行。链接只放 http(s) 与 mailto，别的 scheme 只留文字。
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
    // 行内 html 与 tag 记号一律按文字画：那是模型写的字符，不是界面要执行的标签。
    default: return <span key={key}>{typeof (token as { raw?: string }).raw === 'string' ? (token as { raw: string }).raw : ''}</span>;
  }
}

function safeHref(href: string): string {
  const [scheme] = href.split(':');
  return /^(https?|mailto)$/i.test(scheme) ? href : '';
}

// 代码围栏上那一枚复制：交出去的是这一段没上色之前的原文，不是画面上带了标签的那一份。
// 剪贴板走 WebView2 自带的 `navigator.clipboard`，不引依赖。成与不成都要说一句：
// 看得到代码却拿不走，比默默不动要查得好。
function CodeBlock({ code }: { code: Tokens.Code }) {
  const [said, setSaid] = useState('');
  return <div className="md-code-wrap">
    <pre className="md-code" data-lang={code.lang ?? ''}><code className="hljs" dangerouslySetInnerHTML={{ __html: highlight(code.text, code.lang) }} /></pre>
    <p className="code-copy-row">
      <button type="button" className="code-copy" onClick={() => {
        void navigator.clipboard.writeText(code.text).then(
          () => setSaid(`已复制这段代码（${code.text.length} 字）`),
          () => setSaid('复制没成：这一具界面拿不到剪贴板'),
        );
      }}>复制代码</button>
      {said !== '' && <span className="row-note">{said}</span>}
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
    // 认不了的记号（含 html 块）按原文画出来：宁可看见尖括号，也不要执行它。
    out.push(<p key={id}>{(at as { raw?: string; text?: string }).raw ?? (at as { text?: string }).text ?? ''}</p>);
  });
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lexer = new Lexer({ gfm: true, breaks: false });
  return <div className="markdown">{block(lexer.lex(text), 'md')}</div>;
}
