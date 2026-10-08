import { Markdown } from '../markdown';
import type { RowProps } from './types';

// 回答那一格不套卡片：正文就是这一列的主体（D97）。
export function AnswerRow({ row }: RowProps) {
  return <article className="row answer" data-kind="answer"><div className="row-body"><Markdown text={row.text} /></div></article>;
}
