import type { RowProps } from './types';

// 用户输入的消息显示在内容列右侧，以区分发言方。
export function QuestionRow({ row }: RowProps) {
  return <article className="row question" data-kind="question"><div className="row-body">{row.text}</div></article>;
}
