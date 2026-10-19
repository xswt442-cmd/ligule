import { Group, Row } from '../ui';
import { PALETTES, type Palette, type Settings } from '../../settings';
import { useText } from '../../locale';

const PALETTE_NAMES: Record<Palette, [string, string]> = {
  ink: ['墨青', 'Ink'],
  parchment: ['羊皮纸', 'Parchment'],
  sky: ['蓝天', 'Sky'],
  graphite: ['石墨', 'Graphite'],
  forest: ['森林', 'Forest'],
  dusk: ['黄昏', 'Dusk'],
};

export function AppearanceSettings({ settings, patch }: { settings: Settings; patch: (part: Partial<Settings>) => void }) {
  const t = useText();
  return <>
    <Group title={t('配色方案', 'Color palette')}>
      <div className="swatch-list">
        {PALETTES.map((id) => <button
          key={id}
          type="button"
          className="swatch"
          aria-pressed={settings.palette === id}
          title={t(`换成${PALETTE_NAMES[id][0]}`, `Switch to ${PALETTE_NAMES[id][1]}`)}
          onClick={() => patch({ palette: id })}
        >
          <span className="swatch-chips" data-palette={id}>
            <span style={{ background: 'var(--bg)' }} />
            <span style={{ background: 'var(--accent)' }} />
            <span style={{ background: 'var(--fg)' }} />
          </span>
          <span className="swatch-name">{t(...PALETTE_NAMES[id])}</span>
        </button>)}
      </div>
    </Group>
    <Group title={t('文字与栏宽', 'Text and layout')}>
      <Row label={t('界面字号', 'Interface font size')} note={`${settings.fontUi} px`}>
        <input aria-label={t('界面字号（像素）', 'Interface font size (pixels)')} type="range" min={10} max={24} step={1} value={settings.fontUi} onChange={(event) => patch({ fontUi: Number(event.target.value) })} />
        <input aria-label={t('界面字号数值', 'Interface font size value')} type="number" min={10} max={24} step={1} value={settings.fontUi} onChange={(event) => patch({ fontUi: Math.max(10, Math.min(24, Number(event.target.value) || 10)) })} />
      </Row>
      <Row label={t('用户消息字号', 'User message font size')} note={`${settings.fontUser} px`}>
        <input aria-label={t('用户消息字号（像素）', 'User message font size (pixels)')} type="range" min={12} max={32} step={1} value={settings.fontUser} onChange={(event) => patch({ fontUser: Number(event.target.value) })} />
        <input aria-label={t('用户消息字号数值', 'User message font size value')} type="number" min={12} max={32} step={1} value={settings.fontUser} onChange={(event) => patch({ fontUser: Math.max(12, Math.min(32, Number(event.target.value) || 12)) })} />
      </Row>
      <Row label={t('模型回复字号', 'Assistant reply font size')} note={`${settings.fontAssistant} px`}>
        <input aria-label={t('模型回复字号（像素）', 'Assistant reply font size (pixels)')} type="range" min={12} max={32} step={1} value={settings.fontAssistant} onChange={(event) => patch({ fontAssistant: Number(event.target.value) })} />
        <input aria-label={t('模型回复字号数值', 'Assistant font size value')} type="number" min={12} max={32} step={1} value={settings.fontAssistant} onChange={(event) => patch({ fontAssistant: Math.max(12, Math.min(32, Number(event.target.value) || 12)) })} />
      </Row>
      <Row label={t('会话正文行距', 'Conversation line spacing')} note={`${settings.transcriptLineHeight.toFixed(1)}× · ${Math.round(settings.fontAssistant * settings.transcriptLineHeight)} px`}>
        <input aria-label={t('会话正文行距', 'Conversation line spacing')} type="range" min={1.2} max={2.4} step={0.1} value={settings.transcriptLineHeight} onChange={(event) => patch({ transcriptLineHeight: Number(event.target.value) })} />
        <output>{settings.transcriptLineHeight.toFixed(1)}×</output>
      </Row>
      <Row label={t('侧栏宽度', 'Sidebar width')} note={t(`${settings.sidebar} 像素；也可以拖动侧栏分隔线。`, `${settings.sidebar} px. You can also drag the sidebar divider.`)}>
        <input type="range" min={264} max={420} step={4} value={settings.sidebar} onChange={(event) => patch({ sidebar: Number(event.target.value) })} />
      </Row>
      <Row label={t('面板停靠', 'Panel position')}>
        <select value={settings.dock} onChange={(event) => patch({ dock: event.target.value as Settings['dock'] })}>
          <option value="right">{t('右侧', 'Right')}</option>
          <option value="left">{t('左侧', 'Left')}</option>
        </select>
      </Row>
      <Row label={t('左侧栏', 'Sidebar')}>
        <button type="button" onClick={() => patch({ collapsed: !settings.collapsed })}>{settings.collapsed ? t('展开左侧栏', 'Show sidebar') : t('收起左侧栏', 'Hide sidebar')}</button>
      </Row>
    </Group>
    <Group title={t('工作步骤展示', 'Work details')}>
      <Row label={t('展示详细程度', 'Detail level')} note={t('控制屏幕显示的步骤；模型收到的内容保持完整。', 'Controls which steps appear on screen. The model still receives the full content.')}>
        <select value={settings.verbosity} onChange={(event) => patch({ verbosity: event.target.value as Settings['verbosity'] })}>
          <option value="brief">{t('简洁', 'Brief')}</option>
          <option value="standard">{t('标准', 'Standard')}</option>
          <option value="detailed">{t('详细', 'Detailed')}</option>
          <option value="full">{t('完全展开', 'Full')}</option>
        </select>
      </Row>
    </Group>
  </>;
}
