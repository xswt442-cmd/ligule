import { Fold } from './Fold';
import { useText } from '../locale';
import { callRowFoldLabel } from '../rows';
import type { RowProps } from './types';

// 调用卡片摘要只显示能力名称和操作对象；完整参数可展开查看。
export function CallRow({ row, verbosity }: RowProps) {
  const t = useText();
  const question = row.tool === 'ask_user_question';
  const pathOnly = (() => {
    try {
      const parsed: unknown = JSON.parse(row.text);
      if (parsed === null || typeof parsed !== 'object') return false;
      const keys = Object.keys(parsed as Record<string, unknown>);
      return keys.length === 1 && keys[0] === 'path';
    } catch {
      return false;
    }
  })();
  return <article className="row call" data-kind="call">
    <div className="row-head">
      {question
        ? <span className="row-verb">{t('提问', 'Questions')}</span>
        : <code className="row-tool">{row.tool}</code>}
      {row.summary !== undefined && row.summary !== '' && <span className="row-target-inline">{row.summary}</span>}
    </div>
    {/* 只有路径这类单键参数不值得单独展开：目标已经在标题行，正文只放真正有用的参数。 */}
    {!pathOnly && <Fold text={row.text} verbosity={verbosity} always label={callRowFoldLabel(row.text, t)} />}
  </article>;
}
