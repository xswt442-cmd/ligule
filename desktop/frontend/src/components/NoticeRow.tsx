import type { RowProps } from './types';

export function NoticeRow({ row }: RowProps) {
  return <article className={`row ${row.kind}`} data-kind={row.kind}><div className="row-body">{row.text}</div></article>;
}
