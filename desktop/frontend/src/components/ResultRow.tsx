import type { RowProps } from './types';

export function ResultRow({ row }: RowProps) {
  return <article className="row result" data-kind="result"><div className="row-head">{row.tool} · 完成</div><div className="row-body">{row.text}</div></article>;
}
