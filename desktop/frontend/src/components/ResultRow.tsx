import { Fold } from './Fold';
import type { RowProps } from './types';

// 结果卡片那一行读数：退出码、溢出文件、判定那一条、支线、用时（D77、D94）。
export function ResultRow({ row, verbosity }: RowProps) {
  return <article className="row result" data-kind="result">
    <div className="row-head">
      <code className="row-tool">{row.tool}</code>
      <span className="state-ok">完成</span>
      {row.diff !== undefined && <span className="diff">
        {row.diff.removed > 0 && <span className="diff-minus">−{row.diff.removed}</span>}
        <span className="diff-plus">+{row.diff.added}</span>
      </span>}
      {row.summary !== undefined && row.summary !== '' && <span className="row-target-inline">{row.summary}</span>}
      {row.notes?.map((note) => <span className="row-note" key={note}>{note}</span>)}
    </div>
    <Fold text={row.text} verbosity={verbosity} />
  </article>;
}
