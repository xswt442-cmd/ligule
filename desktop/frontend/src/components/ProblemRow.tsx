import { Fold } from './Fold';
import { useText } from '../locale';
import { failureExplanation } from '../turn-failure';
import type { RowProps } from './types';

// 拒绝和失败使用相同的数据结构，通过稳定错误码区分。
export function ProblemRow({ row, verbosity }: RowProps) {
  const t = useText();
  // 失败行先给一句人话，原始错误码与详情正文收进「原始信息」，避免把协议字段直接甩到对话里。
  const failure = row.kind === 'failure' && row.code !== undefined ? failureExplanation(row.code, row.text) : undefined;
  const body = failure === undefined ? row.text : failure.explanation[0];
  const englishBody = failure === undefined ? row.text : failure.explanation[1];
  return <article className={`row ${row.kind}`} data-kind={row.kind} data-failed="true">
    <div className="row-head">
      <code className="row-tool">{row.tool}</code>
      <span className="state-bad">{row.kind === 'refusal' ? t('未获允许', 'Refused') : t('失败', 'Failed')}</span>
      {row.code !== undefined && failure === undefined && <code className="row-code">{row.code}</code>}
      {row.summary !== undefined && row.summary !== '' && <span className="row-target-inline">{row.summary}</span>}
      {row.notes?.map((note) => <span className="row-note" key={note}>{note}</span>)}
    </div>
    <Fold text={t(body, englishBody)} verbosity={verbosity} />
    {failure === undefined
      ? null
      : <details className="row-details"><summary>{t('原始信息', 'Original message')}</summary><code>{row.code}</code>{row.text === '' ? null : <p>{row.text}</p>}</details>}
  </article>;
}
