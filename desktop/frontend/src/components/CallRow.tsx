import { Fold } from './Fold';
import type { RowProps } from './types';

// 调用卡片：抬头是那一件能力真正叫什么，下面那一行说它对着哪个对象（D94）。
export function CallRow({ row, verbosity }: RowProps) {
  return <article className="row call" data-kind="call">
    <div className="row-head"><span>调用</span><code className="row-tool">{row.tool}</code></div>
    {row.summary !== undefined && row.summary !== '' && <div className="row-target">{row.summary}</div>}
    <Fold text={row.text} verbosity={verbosity} />
  </article>;
}
