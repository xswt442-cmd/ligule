import { Fold } from './Fold';
import { useText } from '../locale';
import type { RowProps } from './types';

// 拒绝和失败使用相同的数据结构，通过稳定错误码区分。
export function ProblemRow({ row, verbosity }: RowProps) {
  const t = useText();
  return <article className={`row ${row.kind}`} data-kind={row.kind} data-failed="true">
    <div className="row-head">
      <code className="row-tool">{row.tool}</code>
      <span className="state-bad">{row.kind === 'refusal' ? t('未获允许', 'Refused') : t('失败', 'Failed')}</span>
      {row.code !== undefined && <code className="row-code">{row.code}</code>}
      {row.summary !== undefined && row.summary !== '' && <span className="row-target-inline">{row.summary}</span>}
      {row.notes?.map((note) => <span className="row-note" key={note}>{note}</span>)}
    </div>
    <Fold text={row.text} verbosity={verbosity} />
  </article>;
}
