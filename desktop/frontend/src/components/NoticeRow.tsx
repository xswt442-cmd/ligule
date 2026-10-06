import type { RowProps } from './types';

// 界面自己说的话（本轮结束、取消、状态读不到）与连接上的问题：不是记录里的东西。
export function NoticeRow({ row }: RowProps) {
  return <article className={`row ${row.kind}`} data-kind={row.kind}><div className="row-head">{row.kind === 'meta' ? '界面' : '出问题了'}</div><div className="row-body">{row.text}</div></article>;
}
