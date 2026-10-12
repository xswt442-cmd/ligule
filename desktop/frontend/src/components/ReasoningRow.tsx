import { Fold } from './Fold';
import { useText } from '../locale';
import type { RowProps } from './types';

export function ReasoningRow({ row, verbosity }: RowProps) {
  const t = useText();
  return <article className="row reasoning" data-kind="reasoning">
    <div className="row-head">{t('推理', 'Reasoning')}</div>
    <Fold text={row.text} verbosity={verbosity} />
  </article>;
}
