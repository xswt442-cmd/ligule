// 视图行到组件的那一次分派（D88）。这里只按 `kind` 挑组件，不认识会话记录本身。
import type { Row } from '../rows';
import { AnswerRow } from './AnswerRow';
import { CallRow } from './CallRow';
import { NoticeRow } from './NoticeRow';
import { ProblemRow } from './ProblemRow';
import { QuestionRow } from './QuestionRow';
import { ReasoningRow } from './ReasoningRow';
import { ResultRow } from './ResultRow';

export function RowView({ row }: { row: Row }) {
  switch (row.kind) {
    case 'question': return <QuestionRow row={row} />;
    case 'answer': return <AnswerRow row={row} />;
    case 'reasoning': return <ReasoningRow row={row} />;
    case 'call': return <CallRow row={row} />;
    case 'result': return <ResultRow row={row} />;
    case 'refusal':
    case 'failure': return <ProblemRow row={row} />;
    default: return <NoticeRow row={row} />;
  }
}
