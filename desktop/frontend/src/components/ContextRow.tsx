import type { RowProps } from './types';

// 一轮开始时的参数快照那一行：说清这一轮用的模型、模式与审批档位来自哪一处。它是界面读出来的一行小字，不进模型上下文。
export function ContextRow({ row }: RowProps) {
  return <article className="row context" data-kind="context"><div className="row-body">{row.text}</div></article>;
}
