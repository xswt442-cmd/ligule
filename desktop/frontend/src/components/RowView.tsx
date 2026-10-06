// 视图行到组件的那一次分派（D88）。这里只按 `kind` 挑组件，不认识会话记录本身。
// 写入一条记录会让整份列表重新渲染一次：记录里的行对象本身没变，跳过它们才让追加便宜得下来。
import { memo, type ReactElement } from 'react';
import type { Row } from '../rows';
import type { RowProps } from './types';
import { AnswerRow } from './AnswerRow';
import { CallRow } from './CallRow';
import { NoticeRow } from './NoticeRow';
import { ProblemRow } from './ProblemRow';
import { QuestionRow } from './QuestionRow';
import { ReasoningRow } from './ReasoningRow';
import { ResultRow } from './ResultRow';

const VIEWS: Record<Row['kind'], (props: RowProps) => ReactElement> = {
  question: QuestionRow,
  answer: AnswerRow,
  reasoning: ReasoningRow,
  call: CallRow,
  result: ResultRow,
  refusal: ProblemRow,
  failure: ProblemRow,
  meta: NoticeRow,
  error: NoticeRow,
};

export const RowView = memo(function RowView(props: RowProps) {
  const View = VIEWS[props.row.kind];
  return <View {...props} />;
});
