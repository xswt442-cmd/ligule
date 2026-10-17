import type { RowProps } from './types';

// 显示轮次开始时的模型、模式和审批策略快照；该摘要不进入模型上下文。
export function ContextRow({ row }: RowProps) {
  return <article className="row context" data-kind="context"><div className="row-body">{row.text}</div></article>;
}
