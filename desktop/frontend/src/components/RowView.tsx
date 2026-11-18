// 根据视图行的 `kind` 选择对应组件；此处不解析会话记录。
// 记录追加时复用未变化的行对象，减少列表重绘。
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
import { RoundRow } from './RoundRow';
import { ContextRow } from './ContextRow';
import { useLocale } from '../locale';

const VIEWS: Record<Row['kind'], (props: RowProps) => ReactElement> = {
  question: QuestionRow,
  answer: AnswerRow,
  reasoning: ReasoningRow,
  call: CallRow,
  result: ResultRow,
  refusal: ProblemRow,
  failure: ProblemRow,
  round: RoundRow,
  context: ContextRow,
  meta: NoticeRow,
  error: NoticeRow,
};

export const RowView = memo(function RowView(props: RowProps) {
  const locale = useLocale();
  if (locale === 'en' && props.row.english !== undefined) props = { ...props, row: { ...props.row, ...props.row.english } };
  const View = VIEWS[props.row.kind];
  const sideChatSource = props.row.seq === undefined ? {} : {
    'data-side-chat-kind': 'event',
    'data-side-chat-seq': String(props.row.seq),
  };
  if (props.flash !== true && props.row.seq === undefined) return <View {...props} />;
  if (props.flash !== true) return <div style={{ display: 'contents' }} {...sideChatSource}><View {...props} /></div>;
  // 仅为高亮行增加包装节点，避免改变其他行的结构。
  return <div className="row-flash" {...sideChatSource}><View {...props} /></div>;
});
