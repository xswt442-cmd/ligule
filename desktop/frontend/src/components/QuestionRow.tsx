import type { RowProps } from './types';
import { useText } from '../locale';

export function QuestionRow({ row }: RowProps) {
  const t = useText();
  return <article className={row.source === 'controller' ? 'row question controller' : 'row question'} data-kind="question" data-source={row.source ?? 'human'}>
    {row.source === 'controller' && <div className="question-source">{t('外部 Agent', 'External agent')}</div>}
    <div className="row-body">{row.text}</div>
  </article>;
}
