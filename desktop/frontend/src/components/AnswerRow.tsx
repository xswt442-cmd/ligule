import { useState } from 'react';
import { Markdown } from '../markdown';
import type { RowProps } from './types';
import { useText } from '../locale';

export function AnswerRow({ row }: RowProps) {
  const t = useText();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(row.text);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };
  return <article className="row answer" data-kind="answer">
    <div className="row-body"><Markdown text={row.text} /></div>
    <div className="inline-field">
      <button type="button" className="mini chip" onClick={() => void copy()}>
        {copyState === 'failed' ? t('重试复制', 'Retry copy') : t('复制回答', 'Copy answer')}
      </button>
      <span role="status" aria-live="polite">{copyState === 'copied' ? t('已复制', 'Copied') : copyState === 'failed' ? t('复制失败', 'Copy failed') : ''}</span>
    </div>
  </article>;
}
