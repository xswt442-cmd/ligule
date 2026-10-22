import { useEffect, useRef, useState } from 'react';
import { useText } from '../locale';
import type { Verbosity } from './types';

// 长文本默认限制为一屏高度，并提供展开查看入口。
// 展开状态由界面维护，不写入会话记录或配置。
const LINES = 12;
const CHARS = 600;

export function Fold({ text, verbosity, always = false, label = '看全文', onExpand }: {
  text: string;
  verbosity: Verbosity;
  always?: boolean;
  label?: string;
  onExpand?: () => void;
}) {
  const t = useText();
  const [forced, setForced] = useState<boolean | null>(null);
  if (text === '') return null;
  const long = always || text.length > CHARS || text.split('\n').length > LINES;
  const open = forced ?? verbosity === 'full';
  const detailsRequested = useRef(false);
  useEffect(() => {
    if (open && !detailsRequested.current) {
      detailsRequested.current = true;
      onExpand?.();
    }
  }, [onExpand, open]);
  return <>
    <div className="row-body" data-folded={long && !open ? (always ? 'tight' : 'true') : undefined}>{text}</div>
    {long && <button
      type="button"
      className="fold-toggle"
      aria-expanded={open}
      onClick={() => {
        if (!open && !detailsRequested.current) {
          detailsRequested.current = true;
          onExpand?.();
        }
        setForced(!open);
      }}
    >{open ? t('收起', 'Show less') : label === '看全文' ? t('看全文', 'Show more') : label}</button>}
  </>;
}
