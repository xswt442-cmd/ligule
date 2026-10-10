import enManual from '../../../../docs/guide.en.md?raw';
import zhManual from '../../../../docs/guide.zh-CN.md?raw';
import { Markdown } from '../markdown';
import { useLocale, useText } from '../locale';

export function HelpPanel() {
  const locale = useLocale();
  const t = useText();
  return <>
    <p className="sheet-note">{t('帮助内容随界面语言切换。', 'The help guide follows the interface language.')}</p>
    <Markdown text={locale === 'zh' ? zhManual : enManual} />
  </>;
}
