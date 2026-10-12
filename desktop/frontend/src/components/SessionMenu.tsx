import { useState } from 'react';
import { Popover } from 'radix-ui';
import { keepEscape } from './ui';
import type { Status } from '../status';
import { useText } from '../locale';

const MODE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODE_LAYERS: Record<string, [string, string]> = {
  shipped: ['随包', 'bundled'],
  user: ['用户', 'user'],
  project: ['项目', 'project'],
};

export function SessionMenu({ status, onSetMode, onSetPolicy }: {
  status: Status | null;
  onSetMode: (name: string) => void;
  onSetPolicy: (mode: 'ask' | 'auto' | null) => void;
}) {
  const t = useText();
  const [draft, setDraft] = useState('');
  const [modeError, setModeError] = useState(false);
  const send = () => {
    const name = draft.trim();
    if (name === '') return;
    if (!MODE_NAME.test(name)) {
      setModeError(true);
      return;
    }
    setModeError(false);
    onSetMode(name);
    setDraft('');
  };
  const policySource = status?.policySource ?? 'config';
  const knownModes = [...new Set(['minimal', 'full', status?.mode, status?.pendingMode].filter((name): name is string => typeof name === 'string' && name !== ''))];
  return <Popover.Portal>
    <Popover.Content className="session-menu" side="top" align="start" sideOffset={8}
      aria-label={t('工具模式与审批', 'Tool mode and approvals')} aria-describedby={undefined} onEscapeKeyDown={keepEscape}
    >
      <div className="sm-head">
        <strong>{t('当前会话', 'Current session')}</strong>
        <Popover.Close asChild><button className="icon-button" type="button" aria-label={t('收起', 'Close')}>&times;</button></Popover.Close>
      </div>

      <div className="sm-group">
        <h3>{t('工具模式', 'Tool mode')}</h3>
        <div className="sm-row">
          <span className="sm-label">{t('当前', 'Current')}</span>
          <span className="sm-value mono">{status === null
            ? t('暂无会话', 'No session')
            : `${status.mode ?? t('未设置', 'Not set')} (${MODE_LAYERS[status.modeLayer ?? ''] === undefined ? status.modeLayer ?? t('来源未知', 'source unknown') : t(...MODE_LAYERS[status.modeLayer ?? ''])})`}</span>
        </div>
        {status?.pendingMode !== null && status?.pendingMode !== undefined && <div className="sm-row">
          <span className="sm-label">{t('下一轮生效', 'Pending')}</span>
          <span className="sm-value mono">{status.pendingMode}</span>
        </div>}
        <div className="sm-row">
          <label className="sm-label" htmlFor="session-mode">{t('切换模式', 'Change mode')}</label>
          <span className="inline-field">
            <input id="session-mode" list="session-mode-options" value={draft} placeholder={t('输入模式名', 'Enter a mode name')} aria-label={t('模式名', 'Mode name')} onChange={(event) => { setDraft(event.target.value); setModeError(false); }} onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.key !== 'Enter') return;
              event.preventDefault();
              send();
            }} />
            <datalist id="session-mode-options">{knownModes.map((name) => <option key={name} value={name} />)}</datalist>
            <button type="button" disabled={draft.trim() === ''} onClick={send}>{t('切换', 'Switch')}</button>
          </span>
        </div>
        {modeError && <p className="session-note" data-tone="bad">{t('模式名须以小写字母或数字开头，并且只含小写字母、数字、点、下划线或连字符。', 'Use 1–64 lowercase letters, numbers, dots, underscores, or hyphens; the name must start with a letter or number.')}</p>}
      </div>

      <div className="sm-group">
        <h3>{t('审批方式', 'Approval mode')}</h3>
        <div className="sm-row">
          <span className="sm-label">{t('当前', 'Current')}</span>
          <span className="sm-value mono">{status === null
            ? t('暂无会话', 'No session')
            : `${status.policy} · ${policySource === 'session' ? t('本会话', 'this session') : t('配置默认', 'configuration default')}`}</span>
        </div>
        <div className="sm-row">
          <span className="sm-label">{t('切换为', 'Set to')}</span>
          <span className="inline-field">
            <button type="button" disabled={status?.policy === 'ask' && policySource === 'session'} onClick={() => onSetPolicy('ask')}>{t('逐次询问', 'Ask each time')}</button>
            <button type="button" disabled={status?.policy === 'auto' && policySource === 'session'} onClick={() => onSetPolicy('auto')}>{t('自动放行', 'Automatic')}</button>
            <button type="button" disabled={policySource !== 'session'} onClick={() => onSetPolicy(null)}>{t('使用配置默认', 'Use default')}</button>
          </span>
        </div>
        {status !== null && status.denials.total > 0 && <div className="sm-row">
          <span className="sm-label">{t('拒绝次数', 'Denials')}</span>
          <span className="sm-value">{t(`连续 ${status.denials.consecutive} 次 · 共 ${status.denials.total} 次`, `${status.denials.consecutive} consecutive · ${status.denials.total} total`)}</span>
        </div>}
      </div>
    </Popover.Content>
  </Popover.Portal>;
}
