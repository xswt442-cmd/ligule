import { useEffect, useMemo, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { HoldSheet } from './HoldSheet';
import { ModelPanel } from './ModelPanel';
import { AgentControlPanel } from './AgentControlPanel';
import { NotificationPanel } from './NotificationPanel';
import { SecuritySettings } from './settings/SecuritySettings';
import { ToolsSettings } from './settings/ToolsSettings';
import { Modal } from './ui';
import { holdReasons, report, type EditGate } from '../edit-gate';
import type { Settings } from '../settings';
import type { Client } from '../protocol';
import type { Status } from '../status';
import { useText } from '../locale';
import type { NotificationBridge } from '../notifications';
import { GeneralSettings } from './settings/GeneralSettings';
import { AppearanceSettings } from './settings/AppearanceSettings';
import { KeyboardSettings } from './settings/KeyboardSettings';
import { AboutSettings } from './AboutSettings';

const SECTIONS = ['general', 'model', 'security', 'tools', 'control', 'notifications', 'keys', 'about'] as const;

export type SettingsSectionId = (typeof SECTIONS)[number];

export type SettingsProps = {
  initialSection?: SettingsSectionId;
  client: Client;
  sessionId: string | null;
  // 当前会话所属项目决定配置读取和写入的项目范围。
  projectRoot: string;
  status: Status | null;
  settings: Settings;
  notifications?: NotificationBridge;
  notificationProblem: string | null;
  notificationPending: boolean;
  patch: (part: Partial<Settings>) => void;
  // 快捷键设置显示偏好读取失败信息和当前有效绑定。
  keyNotice: string;
  link: string | null;
  logs: string[];
  onStatus: (status: Status) => void;
  counts: { sent: number; received: number };
  waiting: number;
  onReconnect: () => void;
  onEdit: (reasons: string[]) => void;
  onClose: () => void;
};

export function SettingsDialog(props: SettingsProps) {
  const t = useText();
  const [section, setSection] = useState<SettingsSectionId>(props.initialSection ?? 'general');
  const [gate, setGate] = useState<EditGate>({});
  const [holding, setHolding] = useState<{ reasons: string[]; go: () => void } | null>(null);
  const { settings, patch } = props;
  useEffect(() => {
    props.onEdit(holdReasons(gate));
    return () => props.onEdit([]);
  }, [gate, props.onEdit]);

  const reports = useMemo(() => ({
    model: (reason: string) => setGate((now) => report(now, 'model', reason)),
    rules: (reason: string) => setGate((now) => report(now, 'rules', reason)),
    control: (reason: string) => setGate((now) => report(now, 'control', reason)),
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
      <div className="sheet-body" role="tabpanel" tabIndex={0}>
        {props.notificationPending && <p className="session-note">{t('关闭设置后将打开通知对应的会话。', 'Close settings to open the conversation from your notification.')}</p>}
        {section === 'general' && <>
          <GeneralSettings client={props.client} language={settings.language} patch={patch} />
          <AppearanceSettings settings={settings} patch={patch} />
        </>}
        {section === 'model' && <Model client={props.client} sessionId={props.sessionId} projectRoot={props.projectRoot} onEdit={reports.model} />}
        {section === 'security' && <SecuritySettings client={props.client} projectRoot={props.projectRoot} sessionId={props.sessionId} status={props.status} onStatus={props.onStatus} onEdit={reports.rules} />}
        {section === 'tools' && <ToolsSettings client={props.client} projectRoot={props.projectRoot} sessionId={props.sessionId} />}
        {section === 'control' && <AgentControlPanel client={props.client} projectRoot={props.projectRoot} onEdit={reports.control} />}
        {section === 'notifications' && <NotificationPanel preferences={settings.notifications} bridge={props.notifications} problem={props.notificationProblem} onChange={notifications => patch({ notifications })} />}
        {section === 'keys' && <KeyboardSettings settings={settings} patch={patch} notice={props.keyNotice} />}
        {section === 'about' && <AboutSettings client={props.client} projectRoot={props.projectRoot} sessionId={props.sessionId} status={props.status} counts={props.counts} waiting={props.waiting} link={props.link} logs={props.logs} onReconnect={props.onReconnect} />}
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
function sectionTitle(id: SettingsSectionId, t: (chinese: string, english: string) => string): string {
  const titles: Record<SettingsSectionId, [string, string]> = {
    general: ['常规', 'General'],
    model: ['模型服务', 'Model services'],
    security: ['权限与安全', 'Permissions and security'],
    tools: ['工具与插件', 'Tools and plugins'],
    control: ['外部控制', 'Agent Control'],
    notifications: ['通知', 'Notifications'],
    keys: ['快捷键', 'Keyboard shortcuts'],
    about: ['关于', 'About'],
  };
  const [chinese, english] = titles[id];
  return t(chinese, english);
}

function sectionIcon(id: SettingsSectionId): IconName {
  const icons: Record<SettingsSectionId, IconName> = { general: 'gear', model: 'folder', security: 'shield', tools: 'grid', control: 'shield', notifications: 'bell', keys: 'copy', about: 'help' };
  return icons[id];
}

// 模型服务经 Host 保存到用户默认或项目本地配置，会话的模型选择由输入区管理。
function Model({ client, sessionId, projectRoot, onEdit }: {
  client: Client;
  sessionId: string | null;
  projectRoot: string;
  onEdit?: (reason: string) => void;
}) {
  return <ModelPanel client={client} sessionId={sessionId} projectRoot={projectRoot} onEdit={onEdit} />;
}
