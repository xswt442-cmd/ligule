import type { RowProps } from './types';
import { useText } from '../locale';
import { turnFailure } from '../turn-failure';

// 完整结束轮次显示最终状态，并提供从该轮创建分支的入口。
export function RoundRow({ row, branch, onModels }: RowProps) {
  const t = useText();
  const at = branch === undefined || row.status !== 'completed' ? undefined : row.seq;
  const failure = row.status === 'failed' ? turnFailure(row.code ?? '') : undefined;
  const names: Record<string, [string, string]> = { completed: ['本轮已完成', 'Turn completed'], cancelled: ['本轮已取消', 'Turn cancelled'], failed: ['本轮失败', 'Turn failed'], interrupted: ['本轮意外中断', 'Turn interrupted'] };
  return <article className="row round" data-kind="round">
    <div className="row-body">
      <span>{names[row.status ?? ''] === undefined ? row.text : t(...names[row.status!])}</span>
      {failure !== undefined && <p className="turn-explanation">{t(...failure.explanation)}</p>}
      {failure?.action === 'models' && onModels !== undefined && <button type="button" className="turn-recovery" onClick={onModels}>{t('模型设置', 'Model settings')}</button>}
      {row.code && <details><summary>{t('详情', 'Details')}</summary><code>{row.code}</code></details>}
    </div>
    {at !== undefined && (
      <button type="button" className="row-branch" onClick={() => branch?.(at)} title={t('复制到此轮结束，创建分支会话', 'Create a branch through the end of this turn')}>{t('从这里分支', 'Branch from here')}</button>
    )}
  </article>;
}
