import { Fold } from './Fold';
import type { RowProps } from './types';

// 调用卡片压成一行：那件能力叫什么、对着哪个对象，参数全文靠展开看（D94、D97）。
export function CallRow({ row, verbosity }: RowProps) {
  return <article className="row call" data-kind="call">
    <div className="row-head">
      <span className="row-verb">调用</span>
      <code className="row-tool">{row.tool}</code>
      {row.summary !== undefined && row.summary !== '' && <span className="row-target-inline">{row.summary}</span>}
    </div>
    <Fold text={row.text} verbosity={verbosity} always />
  </article>;
}
