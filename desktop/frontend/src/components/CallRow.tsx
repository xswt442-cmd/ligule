import { Fold } from './Fold';
import { useText } from '../locale';
import type { RowProps } from './types';

// 调用卡片摘要显示能力名称和操作对象；完整参数可展开查看。
export function CallRow({ row, verbosity }: RowProps) {
  const t = useText();
  const question = row.tool === 'ask_user_question';
  return <article className="row call" data-kind="call">
    <div className="row-head">
      <span className="row-verb">{question ? t('提问', 'Questions') : t('调用', 'Call')}</span>
      {!question && <code className="row-tool">{row.tool}</code>}
      {row.summary !== undefined && row.summary !== '' && <span className="row-target-inline">{row.summary}</span>}
    </div>
    <Fold text={row.text} verbosity={verbosity} always />
  </article>;
}
