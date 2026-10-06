import type { RowProps } from './types';

export function ReasoningRow({ row }: RowProps) {
  return <details className="row reasoning" data-kind="reasoning"><summary className="row-head">推理段</summary><div className="row-body">{row.text}</div></details>;
}
