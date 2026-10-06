import type { RowProps } from './types';

// 一轮完整结束那一行：它说得出这一轮收在什么上，也是「从这里分支」那一个把手所在（D68、方案 4.3）。
export function RoundRow({ row, branch }: RowProps) {
  const at = branch === undefined ? undefined : row.seq;
  return <article className="row round" data-kind="round">
    <div className="row-body">{row.text}</div>
    {at !== undefined && (
      <button type="button" className="row-branch" onClick={() => branch?.(at)} title="复制这一份会话到这一轮为止，之后在新的一份里继续">从这里分支</button>
    )}
  </article>;
}
