import { Markdown } from '../markdown';
import type { RowProps } from './types';

export function AnswerRow({ row }: RowProps) {
  return <article className="row answer" data-kind="answer"><div className="row-head">助手</div><div className="row-body"><Markdown text={row.text} /></div></article>;
}
