import type { RowProps } from './types';

// 人打的那一句排在内容列的右侧：读的时候先看到谁说的（D97）。
export function QuestionRow({ row }: RowProps) {
  return <article className="row question" data-kind="question"><div className="row-body">{row.text}</div></article>;
}
