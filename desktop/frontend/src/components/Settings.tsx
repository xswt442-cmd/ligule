import { useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import type { Settings } from '../settings';
import type { Status } from '../status';

// 设置与配置的二级展开：入口一枚，展开才分栏（D98）。
// 每一栏里的取值都读自界面这一侧的状态或 `status.get`；协议里没有的那一条，这一栏说清缺的是哪一件。
const SECTIONS = [
  { id: 'appearance', title: '外观', icon: 'spark' },
  { id: 'mode', title: '模式', icon: 'grid' },
  { id: 'policy', title: '审批规则', icon: 'check' },
  { id: 'model', title: '模型与端点', icon: 'folder' },
  { id: 'connection', title: '连接', icon: 'refresh' },
] as const;

// 模式来自哪一层，终端那一份用的是同一组词；层名不在表里时把原样交出去。
const LAYERS: Record<string, string> = { shipped: '随包', user: '全局', project: '项目' };

export type SectionId = (typeof SECTIONS)[number]['id'];

export type SettingsProps = {
  status: Status | null;
  settings: Settings;
  patch: (part: Partial<Settings>) => void;
  link: string | null;
  counts: { sent: number; received: number };
  waiting: number;
  onSetMode: (name: string) => void;
  onRetry: () => void;
  onClose: () => void;
};

export function SettingsDialog(props: SettingsProps) {
  const [section, setSection] = useState<SectionId>('appearance');
  const [modeDraft, setModeDraft] = useState('');
  const { status, settings, patch } = props;

  return <div className="overlay" onClick={props.onClose}>
    <div className="sheet" role="dialog" aria-modal="true" aria-label="设置" onClick={(event) => event.stopPropagation()}>
      <header className="sheet-head">
        <strong>设置</strong>
        <button type="button" className="icon-button" aria-label="关闭设置" onClick={props.onClose}><Icon name="close" size={15} /></button>
      </header>
      <nav className="sheet-nav">
        {SECTIONS.map((item) => <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={section === item.id}
          className={section === item.id ? 'active' : ''}
          onClick={() => setSection(item.id)}
        ><Icon name={item.icon} size={14} /><span>{item.title}</span></button>)}
      </nav>
      <div className="sheet-body" role="tabpanel">
        {section === 'appearance' && <Appearance settings={settings} patch={patch} />}
        {section === 'mode' && <Mode status={status} draft={modeDraft} onDraft={setModeDraft} onSet={props.onSetMode} />}
        {section === 'policy' && <Policy status={status} />}
        {section === 'model' && <Model />}
        {section === 'connection' && <Connection link={props.link} counts={props.counts} waiting={props.waiting} status={status} onRetry={props.onRetry} />}
      </div>
    </div>
  </div>;
}

function Appearance({ settings, patch }: { settings: Settings; patch: SettingsProps['patch'] }) {
  return <>
    <Row label="主题" note="跟随系统时按这台机器现在用的是深色还是浅色">
      <select value={settings.theme} onChange={(event) => patch({ theme: event.target.value as Settings['theme'] })}>
        <option value="system">跟随系统</option>
        <option value="dark">深色</option>
        <option value="light">浅色</option>
      </select>
    </Row>
    <Row label="字号">
      <select value={settings.font} onChange={(event) => patch({ font: event.target.value as Settings['font'] })}>
        <option value="small">小</option>
        <option value="medium">中</option>
        <option value="large">大</option>
      </select>
    </Row>
    <Row label="侧栏宽度" note={`${settings.sidebar} 像素；左侧那根分隔线也可以直接拖`}>
      <input type="range" min={264} max={420} step={4} value={settings.sidebar} onChange={(event) => patch({ sidebar: Number(event.target.value) })} />
    </Row>
    <Row label="面板停靠">
      <select value={settings.dock} onChange={(event) => patch({ dock: event.target.value as Settings['dock'] })}>
        <option value="right">右侧</option>
        <option value="left">左侧</option>
      </select>
    </Row>
    <Row label="工作步骤展示" note="四档改的是哪些步骤看得见；交给模型的内容一直是全的（D32）">
      <select value={settings.verbosity} onChange={(event) => patch({ verbosity: event.target.value as Settings['verbosity'] })}>
        <option value="brief">简洁</option>
        <option value="standard">标准</option>
        <option value="detailed">详细</option>
        <option value="full">完全展开</option>
      </select>
    </Row>
    <Row label="左侧栏">
      <button type="button" onClick={() => patch({ collapsed: !settings.collapsed })}>{settings.collapsed ? '展开' : '收起'}</button>
    </Row>
  </>;
}

function Mode({ status, draft, onDraft, onSet }: { status: Status | null; draft: string; onDraft: (value: string) => void; onSet: (name: string) => void }) {
  const send = () => {
    if (draft.trim() === '') return;
    onSet(draft.trim());
    onDraft('');
  };
  return <>
    <Row label="现在生效的" note={status === null ? '还没有会话' : `${status.mode ?? '没有装'}（${LAYERS[status.modeLayer ?? ''] ?? status.modeLayer ?? '层名读不到'}）`}>
      <span className="value">{status === null ? '读不到' : `${status.tools.length} 件工具交给模型`}</span>
    </Row>
    {status?.pendingMode !== null && status?.pendingMode !== undefined && <Row label="待生效" note="正在跑的那一轮结束才换（D41）">
      <span className="value">{status.pendingMode}</span>
    </Row>}
    <Row label="换成" note="随包带的是 minimal 与 full；名字写错时那一次调用报 mode_unknown">
      <span className="inline-field">
        <input value={draft} placeholder="模式名" aria-label="要换成的模式名" onChange={(event) => onDraft(event.target.value)} onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          send();
        }} />
        <button type="button" disabled={draft.trim() === ''} onClick={send}>切换</button>
      </span>
    </Row>
    <p className="sheet-note">模式挑的是工具集与提示词片段；判定档位与用哪一个模型都不在模式里（D35、D43）。</p>
  </>;
}

function Policy({ status }: { status: Status | null }) {
  return <>
    <Row label="档位" note={status === null ? '还没有会话' : '连续不允许到阈值时自动回到逐次询问（D17）'}>
      <span className="value">{status?.policy ?? '读不到'}</span>
    </Row>
    <Row label="不允许的次数">
      <span className="value">{status === null ? '读不到' : `连续 ${status.denials.consecutive} 次 · 累计 ${status.denials.total} 次`}</span>
    </Row>
    <p className="sheet-note">档位管的是整个运行。按工具名或者按能力分类收紧那一条还没定（U41），所以这一栏只给读数，不放开关。</p>
  </>;
}

function Model() {
  return <p className="sheet-note">
    服务地址、模型名与限额读的是配置文件的三层（D8）。协议的九条方法里没有读写配置的那一条，所以这一栏没有可以改的东西。
    要看窗口与用量，在「连接」这一栏，以及顶栏那一条上下文读数里。
  </p>;
}

function Connection({ link, counts, waiting, status, onRetry }: {
  link: string | null;
  counts: { sent: number; received: number };
  waiting: number;
  status: Status | null;
  onRetry: () => void;
}) {
  return <>
    <Row label="载体" note="本机不监听端口，界面拿不到地址与凭据（D30）">
      <span className="value">标准输入输出两根管道</span>
    </Row>
    <Row label="帧">
      <span className="value">发出 {counts.sent} 条 · 收到 {counts.received} 条 · 没回 {waiting} 条</span>
    </Row>
    <Row label="这一份会话">
      <span className="value mono">{status?.sessionId ?? '没有会话'}</span>
    </Row>
    <Row label="连接状态" note={link === null ? undefined : '这一侧只能再问一次；把后端进程重新起来是壳的事，那一条命令还没有（U51）'}>
      <span className="inline-field">
        <span className="value">{link === null ? '连着' : `断了 · ${link}`}</span>
        <button type="button" onClick={onRetry}>重问一次</button>
      </span>
    </Row>
  </>;
}

function Row({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return <div className="sheet-row">
    <span className="sheet-label">{label}</span>
    <span className="sheet-value">
      {children}
      {note !== undefined && note !== '' && <span className="sheet-hint">{note}</span>}
    </span>
  </div>;
}
