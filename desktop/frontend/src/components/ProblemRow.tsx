import type { RowProps } from './types';

// 未允许与失败是同一类形状：这一次没做成，差别在稳定码上（D93 把码原样带出来）。
export function ProblemRow({ row }: RowProps) {
  const label = row.kind === 'refusal' ? `${row.tool} · 没让做（${row.code}）` : `${row.tool} · ${row.code}`;
  return <article className={`row ${row.kind}`} data-kind={row.kind} data-failed="true"><div className="row-head">{label}</div><div className="row-body">{row.text}</div></article>;
}
