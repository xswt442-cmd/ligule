import { useState } from 'react';
import type { Status } from '../status';

// 会话级的几格（模式、档位）放在会话这一侧，不再塞进左下角那个全局设置里（第 105 步）：
// 它们跟着这一份会话走，跟「外观、键位、模型与端点」那种整机一份的事不是一类。
// 模式来自哪一层，终端那一份用的是同一组词；层名不在表里时把原样交出去。
const LAYERS: Record<string, string> = { shipped: '随包', user: '全局', project: '项目' };

export function SessionMenu({ status, onSetMode, onClose }: {
  status: Status | null;
  onSetMode: (name: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const send = () => {
    if (draft.trim() === '') return;
    onSetMode(draft.trim());
    setDraft('');
  };
  return <div className="session-menu" role="dialog" aria-label="这一份会话的设置">
    <div className="sm-head">
      <strong>这一份会话</strong>
      <button className="icon-button" type="button" aria-label="收起" onClick={onClose}>&times;</button>
    </div>
    <div className="sm-row">
      <span className="sm-label">模式</span>
      <span className="sm-value mono">{status === null ? '读不到' : `${status.mode ?? '没装'}（${LAYERS[status.modeLayer ?? ''] ?? status.modeLayer ?? '层名读不到'}）`}</span>
    </div>
    {status?.pendingMode !== null && status?.pendingMode !== undefined && <div className="sm-row">
      <span className="sm-label">待生效</span>
      <span className="sm-value mono">{status.pendingMode}</span>
    </div>}
    <div className="sm-row">
      <span className="sm-label">换成</span>
      <span className="inline-field">
        <input value={draft} placeholder="模式名" aria-label="要换成的模式名" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          send();
        }} />
        <button type="button" disabled={draft.trim() === ''} onClick={send}>切换</button>
      </span>
    </div>
    <div className="sm-row">
      <span className="sm-label">档位</span>
      <span className="sm-value mono">{status === null ? '读不到' : status.policy}</span>
    </div>
    {status !== null && status.denials.total > 0 && <div className="sm-row">
      <span className="sm-label">不允许</span>
      <span className="sm-value">连续 {status.denials.consecutive} 次 · 累计 {status.denials.total} 次</span>
    </div>}
    <p className="sm-note">模式挑的是工具集与提示词片段；档位管整个运行。两者都不是整机一份的设置——它们跟着这一份会话（D35、D43、U41）。</p>
  </div>;
}
