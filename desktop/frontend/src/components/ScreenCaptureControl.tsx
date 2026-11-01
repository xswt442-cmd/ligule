import { useEffect, useRef, useState } from 'react';
import { code, type Client } from '../protocol';
import { useText } from '../locale';
import type { Status } from '../status';
import { Icon } from './Icon';
import { Modal } from './ui';

export function ScreenCaptureControl({ client, sessionId, status, disabled, running, onStatus }: {
  client: Client; sessionId: string | null; status: Status | null; disabled: boolean; running: boolean; onStatus: (status: Status) => void;
}) {
  const t = useText();
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const enabled = status?.screenCapture?.enabled === true;
  if (sessionId === null || status?.screenCapture === undefined || status.delegation != null || !status.tools.includes('screenshot')) return null;
  const owner = sessionId;

  const refresh = async () => {
    const updated = await client.call('status.get', { sessionId: owner }, 15_000) as Status;
    if (alive.current) onStatus(updated);
  };
  const setPermission = async (next: boolean) => {
    setBusy(true); setFailure(null);
    try {
      const changed = await client.call('screen-capture.set', { sessionId: owner, enabled: next, ...(next ? { confirmScreenCapture: confirmed } : {}) }, 15_000) as
        { sessionId: string; enabled: boolean; source: 'none' | 'trusted-ui' };
      if (changed.sessionId !== owner || typeof changed.enabled !== 'boolean' || !['none', 'trusted-ui'].includes(changed.source)) throw new Error('screen_capture_status_invalid');
      if (alive.current) { setConfirming(false); setConfirmed(false); }
      await refresh();
    } catch (error) { if (alive.current) { setFailure(code(error)); setNeedsRefresh(true); } }
    finally { if (alive.current) setBusy(false); }
  };

  const label = needsRefresh
    ? t('截图状态待确认，点此刷新', 'Capture status unknown; click to refresh')
    : enabled
      ? t('截图已授权，点此撤销', 'Screen capture allowed; click to revoke')
      : t('授权本会话截图', 'Allow screen capture for this session');

  return <>
    <button type="button" className={`icon-button capture-button${enabled ? ' is-on' : ''}${needsRefresh ? ' is-warn' : ''}`}
      title={label} aria-label={label}
      disabled={disabled || busy || needsRefresh || status.screenCapture.changeAllowed !== true || (!enabled && running)}
      onClick={() => { if (enabled) void setPermission(false); else { setConfirmed(false); setFailure(null); setConfirming(true); } }}>
      <Icon name="screen" size={16} />
    </button>
    {failure !== null && !confirming && <span role="status">{failure}<button type="button" className="mini chip" disabled={busy} onClick={() => { void refresh().then(() => { if (alive.current) { setFailure(null); setNeedsRefresh(false); } }, error => { if (alive.current) setFailure(code(error)); }); }}>{t('刷新状态', 'Refresh status')}</button></span>}
    {confirming && <Modal title={t('允许屏幕截图？', 'Allow screen capture?')} className="confirm" onClose={() => { if (!busy) setConfirming(false); }}>
      <h2>{t('授权当前会话及内部子任务读取屏幕', 'Allow this Session and its children to read the screen')}</h2>
      <p>{t('截图可能包含其他应用、项目或私人信息，并发送给当前图像模型。截图仅读取现有画面，不切换焦点或移动窗口，也不允许鼠标或键盘控制。关闭或重新打开会话后需重新授权。', 'Captures may include other applications, projects or private information and are sent to the selected image model. Capture reads the existing screen without changing focus or moving windows; mouse and keyboard control are not allowed. Closing or reopening the Session requires new consent.')}</p>
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{t('我确认允许截图', 'I confirm screen capture')}</label>
      {failure !== null && <p role="alert">{failure}</p>}
      <div className="confirm-actions"><button type="button" disabled={busy} onClick={() => setConfirming(false)}>{t('取消', 'Cancel')}</button><button type="button" disabled={!confirmed || busy || running} onClick={() => void setPermission(true)}>{t('允许本会话', 'Allow this Session')}</button></div>
    </Modal>}
  </>;
}
