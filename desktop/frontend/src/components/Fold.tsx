import { useState } from 'react';
import type { Verbosity } from './types';

// 长正文默认只给一屏高度，多出来的靠「看全文」那一格（D94）。
// 展开与收起是界面一侧的状态：不回写记录，也不进配置（D81 边界二）。
const LINES = 12;
const CHARS = 600;

export function Fold({ text, verbosity, always = false }: { text: string; verbosity: Verbosity; always?: boolean }) {
  const [forced, setForced] = useState<boolean | null>(null);
  if (text === '') return null;
  const long = always || text.length > CHARS || text.split('\n').length > LINES;
  const open = forced ?? verbosity === 'full';
  return <>
    <div className="row-body" data-folded={long && !open ? (always ? 'tight' : 'true') : undefined}>{text}</div>
    {long && <button
      type="button"
      className="fold-toggle"
      aria-expanded={open}
      onClick={() => setForced(!open)}
    >{open ? '收起' : '看全文'}</button>}
  </>;
}
