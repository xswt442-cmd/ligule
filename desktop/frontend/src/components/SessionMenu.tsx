import { useState } from 'react';
import { Popover } from 'radix-ui';
import { keepEscape } from './ui';
import type { Status } from '../status';

// 会话级的几格（模式、审批档位、拒绝计数）跟着这一份会话走，不塞进整机一份的全局设置里（第 105 步）。
// 档位走 `policy.set`：换成 ask 或 auto 是这一份会话临时改的，退回是把会话那一格清掉、回到配置默认。
// 模式来自哪一层，终端那一份用的是同一组词；层名不在表里时把原样交出去。
const LAYERS: Record<string, string> = { shipped: '随包', user: '全局', project: '项目' };
const SOURCE_NAMES: Record<string, string> = { config: '配置默认', session: '这一份会话改的' };

// 这一份面板锚在顶栏那两枚胶囊下面：收起、点外面收起、焦点交回胶囊都交给 radix 的浮层（方案 4.2），
// 这里只留那一枚「收起」按钮作看得见的出口。
export function SessionMenu({ status, onSetMode, onSetPolicy }: {
  status: Status | null;
  onSetMode: (name: string) => void;
  // `null` 是退回配置默认那一档。
  onSetPolicy: (mode: 'ask' | 'auto' | null) => void;
}) {
  const [draft, setDraft] = useState('');
  const send = () => {
    if (draft.trim() === '') return;
    onSetMode(draft.trim());
    setDraft('');
  };
  const policySource = status?.policySource ?? 'config';
  return <Popover.Portal>
    <Popover.Content className="session-menu" side="bottom" align="end" sideOffset={8}
      aria-label="这一份会话的设置" aria-describedby={undefined} onEscapeKeyDown={keepEscape}
    >
      <div className="sm-head">
        <strong>这一份会话</strong>
        <Popover.Close asChild><button className="icon-button" type="button" aria-label="收起">&times;</button></Popover.Close>
      </div>

      <div className="sm-group">
        <h3>模式</h3>
        <div className="sm-row">
          <span className="sm-label">现在用的</span>
          <span className="sm-value mono">{status === null ? '读不到' : `${status.mode ?? '没装'}（${LAYERS[status.modeLayer ?? ''] ?? status.modeLayer ?? '层名读不到'}）`}</span>
        </div>
        {status?.pendingMode !== null && status?.pendingMode !== undefined && <div className="sm-row">
          <span className="sm-label">等着换的</span>
          <span className="sm-value mono">{status.pendingMode}（这一轮结束时换上）</span>
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
        <p className="sm-note">模式挑的是这一份会话用的工具集与提示词片段。</p>
      </div>

      <div className="sm-group">
        <h3>审批档位</h3>
        <div className="sm-row">
          <span className="sm-label">现在生效</span>
          <span className="sm-value mono">{status === null ? '读不到' : `${status.policy} · 来自${SOURCE_NAMES[policySource]}`}</span>
        </div>
        <div className="sm-row">
          <span className="sm-label">换成</span>
          <span className="inline-field">
            <button type="button" disabled={status?.policy === 'ask' && policySource === 'session'} onClick={() => onSetPolicy('ask')}>每件事都先问</button>
            <button type="button" disabled={status?.policy === 'auto' && policySource === 'session'} onClick={() => onSetPolicy('auto')}>都过关就自动放行</button>
            <button type="button" disabled={policySource !== 'session'} onClick={() => onSetPolicy(null)}>退回配置默认</button>
          </span>
        </div>
        {status !== null && status.denials.total > 0 && <div className="sm-row">
          <span className="sm-label">不允许</span>
          <span className="sm-value">连续 {status.denials.consecutive} 次 · 累计 {status.denials.total} 次</span>
        </div>}
      </div>
    </Popover.Content>
  </Popover.Portal>;
}
