// 使用手册画的是随包的那两份 markdown：构建时正文进界面产物，站点还没有部署时也读得到。
// 正文走回答那一份 Markdown 画法。手册里的相对链接在这一栏是文字，点了不跳——那些位置属于仓库，不属于这一扇窗口。
import { useState } from 'react';
import enManual from '../../../../docs/guide.en.md?raw';
import zhManual from '../../../../docs/guide.zh-CN.md?raw';
import { Markdown } from '../markdown';

const MANUALS = {
  zh: { label: '简体中文', text: zhManual },
  en: { label: 'English', text: enManual },
} as const;

type ManualId = keyof typeof MANUALS;

export function HelpPanel() {
  const [language, setLanguage] = useState<ManualId>(navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en');
  return <>
    <div className="region-group">
      {(Object.keys(MANUALS) as ManualId[]).map((id) => (
        <button key={id} type="button" className={id === language ? 'rail-refresh' : ''} aria-pressed={id === language} onClick={() => setLanguage(id)}>{MANUALS[id].label}</button>
      ))}
      <p className="sheet-note">这一栏读的是随包的这两份手册，两份按同一批能力核对。手册里指向仓库文件的链接在这里只是文字。</p>
    </div>
    <Markdown text={MANUALS[language].text} />
  </>;
}
