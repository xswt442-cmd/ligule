import { Fragment, useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { HoldSheet } from './HoldSheet';
import { ModelPanel } from './ModelPanel';
import { PolicyRules } from './PolicyRules';
import { Group, Modal, Row } from './ui';
import { holdReasons, report, type EditGate } from '../edit-gate';
import { CURRENT, KEYMAP, conflictsIn, formatKeys, setCapturing, specOf, type KeyAction, type KeyView } from '../hotkeys';
import { PALETTES, type Palette, type Settings } from '../settings';
import type { Client } from '../protocol';
import type { Status } from '../status';

// 设置这一层只放整机一份的事：外观、模型与端点、审批规则、连接、键位。
// 跟着某一份会话走的（模式、档位、拒绝计数）不在这里：它们在会话那一侧的浮层里（第 105 步）。
const SECTIONS = [
  { id: 'appearance', title: '外观', icon: 'spark' },
  { id: 'model', title: '模型与端点', icon: 'folder' },
  { id: 'rules', title: '审批规则', icon: 'check' },
  { id: 'connection', title: '连接', icon: 'refresh' },
  { id: 'keys', title: '键位', icon: 'copy' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export type SettingsProps = {
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
  const [section, setSection] = useState<SectionId>('appearance');
  // 哪一栏手里还攥着没写进配置的东西，由那一栏自己报上来；离开这一层的四条出口都读这一份表（审阅 G2）。
  const [gate, setGate] = useState<EditGate>({});
  const [holding, setHolding] = useState<{ reasons: string[]; go: () => void } | null>(null);
  const { settings, patch } = props;

  // 两个报话口的身份保持稳定：栏里的 effect 才不会为自己刚报的那一句反复重画。
  const reports = useMemo(() => ({
    model: (reason: string) => setGate((now) => report(now, 'model', reason)),
    rules: (reason: string) => setGate((now) => report(now, 'rules', reason)),
  }), []);

  // 关闭按钮、Escape、点弹层外面、切页四条出口走同一条判断：没攥着就直接走，攥着先把那几句摆出来问一句。
  const leave = (go: () => void) => {
    const reasons = holdReasons(gate);
    if (reasons.length === 0) go();
    else setHolding({ reasons, go });
  };

  return <>
    <Modal title="设置" className="sheet" onClose={() => leave(props.onClose)}>
      <header className="sheet-head">
        <strong>设置</strong>
        <button type="button" className="icon-button" aria-label="关闭设置" onClick={() => leave(props.onClose)}><Icon name="close" size={15} /></button>
      </header>
      <nav className="sheet-nav">
        {SECTIONS.map((item) => <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={section === item.id}
          className={section === item.id ? 'active' : ''}
          onClick={() => leave(() => setSection(item.id))}
        ><Icon name={item.icon} size={14} /><span>{item.title}</span></button>)}
      </nav>
      <div className="sheet-body" role="tabpanel">
        {section === 'appearance' && <Appearance settings={settings} patch={patch} />}
        {section === 'model' && <Model client={props.client} sessionId={props.sessionId} projectRoot={props.projectRoot} onEdit={reports.model} />}
        {section === 'rules' && <PolicyRules client={props.client} projectRoot={props.projectRoot} onEdit={reports.rules} />}
        {section === 'connection' && <Connection link={props.link} counts={props.counts} waiting={props.waiting} status={props.status} onReconnect={props.onReconnect} />}
        {section === 'keys' && <Keys settings={settings} patch={patch} notice={props.keyNotice} />}
      </div>
    </Modal>
    {holding === null ? null : <HoldSheet
      lead="现在离开会丢掉这些："
      reasons={holding.reasons}
      onStay={() => setHolding(null)}
      onLeave={() => { const go = holding.go; setHolding(null); go(); }}
    />}
  </>;
}

// 配色方案的名字与一句说明：界面上那一枚色板按这一份表排，颜色从 `data-palette` 那一个块自己读，不写在这里。
const PALETTE_NAMES: Record<Palette, string> = {
  ink: '墨青',
  parchment: '羊皮纸',
  sky: '蓝天',
  graphite: '石墨',
  forest: '森林',
  dusk: '黄昏',
};

function Appearance({ settings, patch }: { settings: Settings; patch: SettingsProps['patch'] }) {
  return <>
    <Group title="配色方案">
      <div className="swatch-list">
        {PALETTES.map((id) => <button
          key={id}
          type="button"
          className="swatch"
          aria-pressed={settings.palette === id}
          title={`换成${PALETTE_NAMES[id]}`}
          onClick={() => patch({ palette: id })}
        >
          <span className="swatch-chips" data-palette={id}>
            <span style={{ background: 'var(--bg)' }} />
            <span style={{ background: 'var(--accent)' }} />
            <span style={{ background: 'var(--fg)' }} />
          </span>
          <span className="swatch-name">{PALETTE_NAMES[id]}</span>
        </button>)}
      </div>
    </Group>
    <Group title="文字与栏宽">
      <Row label="字号">
        <select value={settings.font} onChange={(event) => patch({ font: event.target.value as Settings['font'] })}>
          <option value="small">小</option>
          <option value="medium">中</option>
          <option value="large">大</option>
        </select>
      </Row>
      <Row label="侧栏宽度" note={`${settings.sidebar} 像素；左侧那根分隔线也可以用鼠标拖动`}>
        <input type="range" min={264} max={420} step={4} value={settings.sidebar} onChange={(event) => patch({ sidebar: Number(event.target.value) })} />
      </Row>
      <Row label="面板停靠">
        <select value={settings.dock} onChange={(event) => patch({ dock: event.target.value as Settings['dock'] })}>
          <option value="right">右侧</option>
          <option value="left">左侧</option>
        </select>
      </Row>
      <Row label="左侧栏">
        <button type="button" onClick={() => patch({ collapsed: !settings.collapsed })}>{settings.collapsed ? '展开左侧栏' : '收起左侧栏'}</button>
      </Row>
    </Group>
    <Group title="工作步骤展示">
      <Row label="展示详细程度" note="这一格改的是哪些步骤画在屏幕上。交给模型的内容一直是全的。">
        <select value={settings.verbosity} onChange={(event) => patch({ verbosity: event.target.value as Settings['verbosity'] })}>
          <option value="brief">简洁</option>
          <option value="standard">标准</option>
          <option value="detailed">详细</option>
          <option value="full">完全展开</option>
        </select>
      </Row>
    </Group>
  </>;
}

// 键位这一栏：一条动作一行，写着它现在的键、落在哪一个范围。改一记键要先录一次按键——
// 录制状态下窗口那一层不接全局键，Esc 取消这一次录制（方案 6.1）。
function Keys({ settings, patch, notice }: { settings: Settings; patch: SettingsProps['patch']; notice: string }) {
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
        setRefused(`${formatKeys(spec)} 在${binding.view}里已经落在 ${clash[0][0]} 与 ${clash[0][1]} 上。同一个范围里一记键不能落两件事。`);
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
      <Group title={view}>
        {(Object.entries(KEYMAP) as [KeyAction, (typeof KEYMAP)[KeyAction]][])
          .filter(([, binding]) => binding.view === view)
          .map(([action, binding]) => <Row key={action} label={binding.label} note={settings.keys[action] === undefined ? '当前用的是默认键' : `这一条你改过：${settings.keys[action]}`}>
            <code>{formatKeys(CURRENT[action])}</code>
            <button type="button" onClick={() => { setRefused(''); setListening(listening === action ? null : action); }}>
              {listening === action ? '按下新的键（Esc 取消）' : '改键'}
            </button>
            {settings.keys[action] === undefined ? null : <button type="button" onClick={() => restore(action)}>退回默认</button>}
          </Row>)}
      </Group>
    </Fragment>)}
    <Row label="全部键位退回默认" note="清掉本机那一格里的个人覆盖">
      <button type="button" onClick={() => { setRefused(''); patch({ keys: {} }); }}>退回默认</button>
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
  return <>
    <p className="sheet-note">
      服务地址与模型名读的是配置文件那四层里的哪一层，由 <code>config.get</code> 交回；改的时候走 <code>config.set</code>，落进使用者默认或当前项目的本机覆盖两层之一。密钥的值从来不进配置。
    </p>
    {/* 四条可写的行就在这一栏里（第 92 步）：设置页里点进来看到的就是那四个「改」。 */}
    <ModelPanel client={client} sessionId={sessionId} projectRoot={projectRoot} onEdit={onEdit} />
  </>;
}

function Connection({ link, counts, waiting, status, onReconnect }: {
  link: string | null;
  counts: { sent: number; received: number };
  waiting: number;
  status: Status | null;
  onReconnect: () => void;
}) {
  return <>
    <Group title="这一条连接">
      <Row label="载体" note="本机不监听端口，界面拿不到地址与凭据">
        <span className="value">标准输入输出两根管道</span>
      </Row>
      <Row label="帧数">
        <span className="value">发出 {counts.sent} 条 · 收到 {counts.received} 条 · 还没回 {waiting} 条</span>
      </Row>
      <Row label="当前会话">
        <span className="value mono">{status?.sessionId ?? '没有会话'}</span>
      </Row>
      <Row label="连接状态" note={link === null ? undefined : '重连会换一具后端进程。没答复的请求按 `host_restarted` 收尾，还没答的询问作废，这一份会话接回来。'}>
        <span className="inline-field">
          <span className="value">{link === null ? '连着' : `断了 · ${link}`}</span>
          <button type="button" onClick={onReconnect}>重连</button>
        </span>
      </Row>
    </Group>
  </>;
}
