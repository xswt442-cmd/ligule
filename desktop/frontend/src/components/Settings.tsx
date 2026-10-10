import { Fragment, useEffect, useMemo, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { HoldSheet } from './HoldSheet';
import { ModelPanel } from './ModelPanel';
import { PolicyRules } from './PolicyRules';
import { Group, Modal, Row } from './ui';
import { holdReasons, report, type EditGate } from '../edit-gate';
import { CURRENT, KEYMAP, conflictsIn, formatKeys, setCapturing, specOf, type KeyAction, type KeyView } from '../hotkeys';
import { PALETTES, type Palette, type Settings } from '../settings';
import { code, type Client } from '../protocol';
import type { WorkspaceRoster } from '../rail';
import type { Status } from '../status';
import { useText } from '../locale';

const SECTIONS = ['general', 'appearance', 'model', 'rules', 'keys'] as const;

type SectionId = (typeof SECTIONS)[number];

export type SettingsProps = {
  initialSection?: SectionId;
  client: Client;
  sessionId: string | null;
  // 配置那两栏读与写的是哪一份项目：跟着眼前这一份会话走（方案 3.2、审阅 F3）。
  projectRoot: string;
  status: Status | null;
  settings: Settings;
  patch: (part: Partial<Settings>) => void;
  // 键位那一栏要说的两件都在外面读回来：本机那一格里落不下来的那几条，与现在这一份表。
  keyNotice: string;
  link: string | null;
  counts: { sent: number; received: number };
  waiting: number;
  onReconnect: () => void;
  onClose: () => void;
};

export function SettingsDialog(props: SettingsProps) {
  const t = useText();
  const [section, setSection] = useState<SectionId>(props.initialSection ?? 'general');
  const [gate, setGate] = useState<EditGate>({});
  const [holding, setHolding] = useState<{ reasons: string[]; go: () => void } | null>(null);
  const { settings, patch } = props;

  const reports = useMemo(() => ({
    model: (reason: string) => setGate((now) => report(now, 'model', reason)),
    rules: (reason: string) => setGate((now) => report(now, 'rules', reason)),
  }), []);

  const leave = (go: () => void) => {
    const reasons = holdReasons(gate);
    if (reasons.length === 0) go();
    else setHolding({ reasons, go });
  };

  return <>
    <Modal title={t('设置', 'Settings')} className="sheet" onClose={() => leave(props.onClose)}>
      <header className="sheet-head">
        <strong>{t('设置', 'Settings')}</strong>
        <button type="button" className="icon-button" aria-label={t('关闭设置', 'Close settings')} onClick={() => leave(props.onClose)}><Icon name="close" size={15} /></button>
      </header>
      <nav className="sheet-nav">
        {SECTIONS.map((id) => <button
          key={id}
          type="button"
          role="tab"
          aria-selected={section === id}
          className={section === id ? 'active' : ''}
          onClick={() => leave(() => setSection(id))}
        ><Icon name={sectionIcon(id)} size={14} /><span>{sectionTitle(id, t)}</span></button>)}
      </nav>
      <div className="sheet-body" role="tabpanel">
        {section === 'general' && <General client={props.client} language={settings.language} patch={patch} />}
        {section === 'appearance' && <Appearance settings={settings} patch={patch} />}
        {section === 'model' && <Model client={props.client} sessionId={props.sessionId} projectRoot={props.projectRoot} onEdit={reports.model} />}
        {section === 'rules' && <PolicyRules client={props.client} projectRoot={props.projectRoot} onEdit={reports.rules} />}
        {section === 'keys' && <Keys settings={settings} patch={patch} notice={props.keyNotice} />}
      </div>
    </Modal>
    {holding === null ? null : <HoldSheet
      lead={t('离开设置会丢掉这些未保存的修改：', 'Leaving settings will discard these unsaved changes:')}
      reasons={holding.reasons}
      onStay={() => setHolding(null)}
      onLeave={() => { const go = holding.go; setHolding(null); go(); }}
    />}
  </>;
}
function sectionTitle(id: SectionId, t: (chinese: string, english: string) => string): string {
  const titles: Record<SectionId, [string, string]> = {
    general: ['常规', 'General'],
    appearance: ['外观', 'Appearance'],
    model: ['模型服务', 'Model services'],
    rules: ['审批规则', 'Approval rules'],
    keys: ['快捷键', 'Keyboard shortcuts'],
  };
  const [chinese, english] = titles[id];
  return t(chinese, english);
}

function sectionIcon(id: SectionId): IconName {
  const icons: Record<SectionId, IconName> = { general: 'gear', appearance: 'spark', model: 'folder', rules: 'check', keys: 'copy' };
  return icons[id];
}

function General({ client, language, patch }: {
  client: Client;
  language: Settings['language'];
  patch: SettingsProps['patch'];
}) {
  const t = useText();
  const [roster, setRoster] = useState<WorkspaceRoster | null>(null);
  const [failure, setFailure] = useState<{ operation: 'read' | 'save'; code: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    void client.call('workspaces.list', {}, 15_000)
      .then((value) => { if (active) setRoster(value as WorkspaceRoster); })
      .catch((error: unknown) => { if (active) setFailure({ operation: 'read', code: code(error) }); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, reload]);

  const changeDefault = async (directory: string) => {
    setSaving(true);
    setFailure(null);
    try {
      setRoster(await client.call('workspace.default.set', { directory }, 15_000) as WorkspaceRoster);
    } catch (error) {
      setFailure({ operation: 'save', code: code(error) });
    } finally {
      setSaving(false);
    }
  };
  const defaultDirectory = roster?.workspaces.find((workspace) => workspace.identity === roster.default)?.directory ?? '';

  return <>
    <Group title={t('语言', 'Language')}>
      <Row label={t('界面语言', 'Interface language')}>
        <select value={language} onChange={(event) => patch({ language: event.target.value as Settings['language'] })}>
          <option value="auto">{t('跟随系统', 'Follow system')}</option>
          <option value="zh">简体中文</option>
          <option value="en">English</option>
        </select>
      </Row>
    </Group>
    <Group title={t('工作区', 'Workspace')}>
      <Row label={t('默认工作区', 'Default workspace')} note={t('新建会话时使用。只能选择侧栏中已登记的工作区。', 'Used for new sessions. Choose a workspace already listed in the sidebar.')}>
        <select
          value={defaultDirectory}
          disabled={loading || saving || roster === null}
          onChange={(event) => void changeDefault(event.target.value)}
        >
          <option value="">{t('不设置默认工作区', 'No default workspace')}</option>
          {roster?.workspaces.map((workspace) => <option key={workspace.identity} value={workspace.directory}>{workspace.name || workspace.directory}</option>)}
        </select>
      </Row>
      {loading && <p className="stub">{t('正在读取工作区…', 'Loading workspaces…')}</p>}
      {!loading && roster?.workspaces.length === 0 && <p className="stub">{t('侧栏还没有登记工作区。', 'No workspaces are listed in the sidebar yet.')}</p>}
      {failure !== null && <div className="session-note" data-tone="bad">
        <p>{failure.operation === 'read'
          ? t('无法读取工作区列表。', 'Could not load the workspace list.')
          : t('默认工作区没有保存。', 'The default workspace was not saved.')}</p>
        <details><summary>{t('错误代码', 'Error code')}</summary><code>{failure.code}</code></details>
        {failure.operation === 'read' && <button type="button" onClick={() => { setLoading(true); setFailure(null); setReload((value) => value + 1); }}>{t('重新读取', 'Reload')}</button>}
      </div>}
    </Group>
  </>;
}

// 配色方案的名字与一句说明：界面上那一枚色板按这一份表排，颜色从 `data-palette` 那一个块自己读，不写在这里。
const PALETTE_NAMES: Record<Palette, [string, string]> = {
  ink: ['墨青', 'Ink'],
  parchment: ['羊皮纸', 'Parchment'],
  sky: ['蓝天', 'Sky'],
  graphite: ['石墨', 'Graphite'],
  forest: ['森林', 'Forest'],
  dusk: ['黄昏', 'Dusk'],
};

function Appearance({ settings, patch }: { settings: Settings; patch: SettingsProps['patch'] }) {
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
      <Row label={t('字号', 'Font size')}>
        <select value={settings.font} onChange={(event) => patch({ font: event.target.value as Settings['font'] })}>
          <option value="small">{t('小', 'Small')}</option>
          <option value="medium">{t('中', 'Medium')}</option>
          <option value="large">{t('大', 'Large')}</option>
        </select>
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

const KEY_LABELS: Record<KeyAction, [string, string]> = {
  palette: ['打开命令面板', 'Open command palette'],
  sidebar: ['收起或展开侧栏', 'Show or hide the sidebar'],
  'copy-answer': ['复制最后一条回答', 'Copy the latest answer'],
  interrupt: ['收起浮层；浮层关闭后打断本轮', 'Close overlays, then interrupt the round'],
  send: ['发送；运行时排到后面', 'Send, or queue while a round runs'],
  'send-alt': ['发送', 'Send'],
  newline: ['换行', 'Insert a new line'],
  'history-older': ['向上翻输入历史', 'Move back in input history'],
  'history-newer': ['向下翻输入历史', 'Move forward in input history'],
  'pick-candidate': ['选择文件候选', 'Select a file suggestion'],
  'complete-candidate': ['选择文件候选', 'Select a file suggestion'],
  'candidate-older': ['选择上一条候选', 'Select the previous suggestion'],
  'candidate-newer': ['选择下一条候选', 'Select the next suggestion'],
  'hide-candidate': ['收起文件候选', 'Hide file suggestions'],
};

const KEY_VIEWS: Record<KeyView, [string, string]> = {
  '窗口': ['窗口', 'Window'],
  '输入坞': ['输入框', 'Composer'],
  '候选清单': ['文件候选', 'File suggestions'],
};

function Keys({ settings, patch, notice }: { settings: Settings; patch: SettingsProps['patch']; notice: string }) {
  const t = useText();
  const [listening, setListening] = useState<KeyAction | null>(null);
  const [refused, setRefused] = useState('');
  useEffect(() => {
    if (listening === null) return;
    setCapturing(true);
    const stop = () => {
      setCapturing(false);
      setListening(null);
    };
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.key === 'Escape') {
        stop();
        return;
      }
      const spec = specOf(event);
      if (spec === null) return;
      const binding = KEYMAP[listening];
      // 同一个范围里那一记键已经落在别的事上就拒：存下去的表必须是这一份界面按得动的。
      const clash = conflictsIn(binding.view, { ...CURRENT, [listening]: spec });
      if (clash.length > 0) {
        const [first, second] = clash[0];
        setRefused(t(
          `${formatKeys(spec)} 在${KEY_VIEWS[binding.view][0]}里已经用于“${t(...KEY_LABELS[first])}”和“${t(...KEY_LABELS[second])}”。一个范围内不能重复使用同一按键。`,
          `${formatKeys(spec)} is already used for “${t(...KEY_LABELS[first])}” and “${t(...KEY_LABELS[second])}” in the ${KEY_VIEWS[binding.view][1]}. A key can have only one action in each area.`,
        ));
        stop();
        return;
      }
      setRefused('');
      patch({ keys: { ...settings.keys, [listening]: spec } });
      stop();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      setCapturing(false);
    };
  }, [listening, patch, settings.keys]);

  const restore = (action: string) => {
    const next = { ...settings.keys };
    delete next[action];
    patch({ keys: next });
  };
  const views = [...new Set(Object.values(KEYMAP).map((binding) => binding.view))] as KeyView[];
  return <>
    {notice === '' ? null : <p className="stub">{notice}</p>}
    {refused === '' ? null : <p className="session-note" data-tone="bad">{refused}</p>}
    {views.map((view) => <Fragment key={view}>
      <Group title={t(...KEY_VIEWS[view])}>
        {(Object.entries(KEYMAP) as [KeyAction, (typeof KEYMAP)[KeyAction]][])
          .filter(([, binding]) => binding.view === view)
          .map(([action]) => <Row key={action} label={t(...KEY_LABELS[action])} note={settings.keys[action] === undefined ? t('当前使用默认键。', 'Using the default key.') : t(`自定义键：${settings.keys[action]}`, `Custom key: ${settings.keys[action]}`)}>
            <code>{formatKeys(CURRENT[action])}</code>
            <button type="button" onClick={() => { setRefused(''); setListening(listening === action ? null : action); }}>
              {listening === action ? t('按下新键（Esc 取消）', 'Press a new key (Esc to cancel)') : t('更改', 'Change')}
            </button>
            {settings.keys[action] === undefined ? null : <button type="button" onClick={() => restore(action)}>{t('恢复默认', 'Reset')}</button>}
          </Row>)}
      </Group>
    </Fragment>)}
    <Row label={t('恢复所有默认键位', 'Reset all keyboard shortcuts')} note={t('清除这台设备上的个人键位。', 'Clear custom shortcuts on this device.')}>
      <button type="button" onClick={() => { setRefused(''); patch({ keys: {} }); }}>{t('恢复默认', 'Reset')}</button>
    </Row>
  </>;
}

// 模型与端点这一栏读 `config.get`、写 `config.set`，只能改那四条模型字段，落进使用者默认或当前项目的本机覆盖两层之一（方案 7.2）。
// 改完谁什么时候用上它，由这一栏下面那份读数自己说（第 91 步）。审批规则不在这里：它在「审批规则」那一栏。
function Model({ client, sessionId, projectRoot, onEdit }: {
  client: Client;
  sessionId: string | null;
  projectRoot: string;
  onEdit?: (reason: string) => void;
}) {
  const t = useText();
  return <>
    <p className="sheet-note">
      {t('服务地址和模型名由配置读取。编辑保存到使用者默认层或当前项目的本机覆盖层。密钥值不会写入配置。', 'The service address and model name come from configuration. Changes are saved to user defaults or this project’s local override. Secret values are never written to configuration.')}
    </p>
    <ModelPanel client={client} sessionId={sessionId} projectRoot={projectRoot} onEdit={onEdit} />
  </>;
}
