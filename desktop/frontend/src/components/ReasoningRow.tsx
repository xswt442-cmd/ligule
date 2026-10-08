import { Fold } from './Fold';
import type { RowProps } from './types';

export function ReasoningRow({ row, verbosity }: RowProps) {
  return <article className="row reasoning" data-kind="reasoning">
    <div className="row-head">推理段</div>
    <Fold text={row.text} verbosity={verbosity} />
  </article>;
}
