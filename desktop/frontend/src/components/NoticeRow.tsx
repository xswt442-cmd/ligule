import type { RowProps } from './types';

// 界面自己说的话（本轮结束、取消、状态读不到、连接上的问题）：不是记录里的东西，抬头统一写「界面」。
export function NoticeRow({ row }: RowProps) {
  return <article className={`row ${row.kind}`} data-kind={row.kind}><div className="row-head">界面</div><div className="row-body">{row.text}</div></article>;
}
