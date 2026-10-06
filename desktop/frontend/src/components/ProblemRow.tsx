import { Fold } from './Fold';
import type { RowProps } from './types';

// 未允许与失败是同一类形状：这一次没做成，差别在稳定码上（D93 把码原样带出来）。
export function ProblemRow({ row, verbosity }: RowProps) {
  return <article className={`row ${row.kind}`} data-kind={row.kind} data-failed="true">
    <div className="row-head">
      <code className="row-tool">{row.tool}</code>
      <span className="state-bad">{row.kind === 'refusal' ? '不允许' : '失败了'}</span>
      {row.code !== undefined && <code className="row-code">{row.code}</code>}
      {row.summary !== undefined && row.summary !== '' && <span className="row-target-inline">{row.summary}</span>}
      {row.notes?.map((note) => <span className="row-note" key={note}>{note}</span>)}
    </div>
    <Fold text={row.text} verbosity={verbosity} />
  </article>;
}
