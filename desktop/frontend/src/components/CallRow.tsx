import type { RowProps } from './types';

export function CallRow({ row }: RowProps) {
  return <article className="row call" data-kind="call"><div className="row-head">调用 {row.tool}</div><div className="row-body">{row.text}</div></article>;
}
