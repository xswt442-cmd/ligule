import { useState } from 'react';
import type { Usage } from '../status';
import { useLocale, useText } from '../locale';

export function UsageMeter({ usage, seconds, running }: { usage: Usage; seconds: number; running: boolean }) {
  const [open, setOpen] = useState(false);
  const locale = useLocale();
  const t = useText();
  const number = new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US');
  const format = (value: number) => number.format(value);
  const share = Math.min(1, usage.estimated / usage.window);
  const pressure = Math.min(1, usage.threshold / usage.window);
  const rows: [string, string][] = [
    [t('估算 tokens', 'Estimated tokens'), `~${format(usage.estimated)}`],
    [t('上下文窗口', 'Context window'), `${format(usage.window)} ${t('tokens', 'tokens')}`],
    [t('压缩阈值', 'Compaction threshold'), `${format(usage.threshold)} ${t('tokens', 'tokens')}`],
    [t('压缩后保留', 'Retained after compaction'), `${format(usage.retained)} ${t('tokens', 'tokens')}`],
    [t('修正系数', 'Correction factor'), `×${usage.factor.toFixed(2)}`],
    [t('端点报告', 'Endpoint report'), usage.reported === null
      ? t('尚无报告', 'No report yet')
      : t(`第 ${format(usage.reported.seq)} 条 · 入 ${format(usage.reported.input)} · 出 ${usage.reported.output === null ? '—' : format(usage.reported.output)} tokens`, `Event ${format(usage.reported.seq)} · in ${format(usage.reported.input)} · out ${usage.reported.output === null ? '—' : format(usage.reported.output)} tokens`)],
    [t('本轮时长', 'Turn duration'), running ? t(`${seconds} 秒`, `${seconds} sec`) : t('空闲', 'Idle')],
    [t('估算方式', 'Measurement'), usage.measurement],
  ];
  return <span className="usage" data-open={open ? 'true' : undefined}>
    <button
      type="button"
      className="usage-trigger"
      title={t(`估算 ${format(usage.estimated)} tokens · 窗口 ${format(usage.window)} tokens`, `${format(usage.estimated)} tokens estimated · ${format(usage.window)} token window`)}
      aria-label={t('上下文用量', 'Context usage')}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={() => setOpen((current) => !current)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.stopPropagation();
        setOpen(false);
      }}
    >
      <span className="usage-bar" data-over={usage.estimated > usage.threshold ? 'true' : undefined}>
        <span className="usage-fill" style={{ width: `${share * 100}%` }} />
        <span className="usage-line" style={{ insetInlineStart: `${pressure * 100}%` }} />
      </span>
      <span className="usage-text">{t(`${Math.round(share * 100)}% 已用`, `${Math.round(share * 100)}% used`)}</span>
    </button>
    {open && <div className="usage-pop" role="dialog" aria-label={t('上下文用量', 'Context usage')}>
      {rows.map(([label, value]) => <div key={label} className="usage-row">
        <span>{label}</span>
        <b>{value}</b>
      </div>)}
    </div>}
  </span>;
}
