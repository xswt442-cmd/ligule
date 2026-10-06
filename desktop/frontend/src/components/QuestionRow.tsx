import type { RowProps } from './types';

export function QuestionRow({ row }: RowProps) {
  return <article className="row question" data-kind="question"><div className="row-head">你</div><div className="row-body">{row.text}</div></article>;
}
