import { useLayoutEffect, useRef, useState } from 'react';
import { code, type Client } from '../protocol';
import { useText } from '../locale';
import type { BrowserStatus, Status } from '../status';

function isBrowserStatus(value: unknown): value is BrowserStatus {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.configured === 'boolean' && typeof item.available === 'boolean'
    && typeof item.permitted === 'boolean' && typeof item.paused === 'boolean'
    && typeof item.connected === 'boolean' && typeof item.changeAllowed === 'boolean'
    && (item.code === undefined || typeof item.code === 'string');
}

function statusText(browser: BrowserStatus, t: (chinese: string, english: string) => string, needsRefresh: boolean): string {
  if (needsRefresh) return t('浏览器状态待确认', 'Browser status needs confirmation');
  if (!browser.available) return `${t('浏览器不可用', 'Browser unavailable')}${browser.code === undefined ? '' : ` · ${browser.code}`}`;
  if (!browser.permitted) return `${t('当前会话权限不足', 'Session permissions do not allow browser access')}${browser.code === undefined ? '' : ` · ${browser.code}`}`;
  if (browser.paused) return t('浏览器已暂停', 'Browser paused');
  if (browser.connected) return t('MCP 已连接（页面可能尚未打开）', 'MCP connected (no page may be open)');
  return t('浏览器可用，尚未启动', 'Browser available, not started');
}

export function BrowserControl({ client, sessionId, browser, readOnly, onStatus }: {
  client: Client;
  sessionId: string | null;
  browser: BrowserStatus | undefined;
  readOnly: boolean;
  onStatus: (status: Status) => void;
}) {
  const t = useText();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const requestGeneration = useRef(0);

  useLayoutEffect(() => () => { requestGeneration.current += 1; }, [sessionId, readOnly]);

  if (sessionId === null || browser === undefined || !browser.configured) return null;

  const refresh = async (owner: string, generation: number): Promise<void> => {
    if (requestGeneration.current !== generation) return;
    const value = await client.call('status.get', { sessionId: owner }, 15_000) as Status;
    if (requestGeneration.current !== generation) return;
    if (value.sessionId !== owner || !isBrowserStatus(value.browser)) throw new Error('browser_status_invalid');
    onStatus(value);
  };

  const operate = async (method: 'browser.stop' | 'browser.resume') => {
    if (sessionId === null || busy || !browser.changeAllowed || (readOnly)
      || (method === 'browser.resume' && (!browser.available || !browser.permitted))) return;
    const owner = sessionId;
    const generation = ++requestGeneration.current;
    setBusy(true);
    setFailure(null);
    setNeedsRefresh(false);
    let actionFailure: string | undefined;
    try { await client.call(method, { sessionId: owner }, 15_000); }
    catch (error) { actionFailure = code(error); }

    let refreshFailure: string | undefined;
    try { await refresh(owner, generation); }
    catch (error) { refreshFailure = code(error); }
    if (requestGeneration.current === generation) {
      setFailure(actionFailure ?? refreshFailure ?? null);
      setNeedsRefresh(refreshFailure !== undefined);
      setBusy(false);
    }
  };

  const retryRefresh = async () => {
    if (sessionId === null || busy) return;
    const owner = sessionId;
    const generation = ++requestGeneration.current;
    setBusy(true);
    try {
      await refresh(owner, generation);
      if (requestGeneration.current === generation) { setFailure(null); setNeedsRefresh(false); }
    } catch (error) {
      if (requestGeneration.current === generation) { setFailure(code(error)); setNeedsRefresh(true); }
    } finally {
      if (requestGeneration.current === generation) setBusy(false);
    }
  };

  return <div className="browser-control" aria-label={t('浏览器控制', 'Browser control')}>
    <span className="browser-control-status" role="status" title={browser.code ?? undefined}>
      {statusText(browser, t, needsRefresh)}
    </span>
    {readOnly
      ? <span className="browser-control-note">{t('只读观察；接管或关闭会话可终止浏览器。', 'Read-only view; taking over or closing the session can stop the browser.')}</span>
      : !browser.changeAllowed && <span className="browser-control-note">{t('当前窗口不可控制浏览器', 'Browser control is unavailable in this window')}</span>}
    {!readOnly && browser.changeAllowed && <span className="browser-control-actions">
        {!browser.paused && <button type="button" className="mini chip" disabled={busy || needsRefresh} onClick={() => void operate('browser.stop')}>
          {t('停止浏览器', 'Stop browser')}
        </button>}
        {browser.paused && <button type="button" className="mini chip" disabled={busy || needsRefresh || !browser.available || !browser.permitted} onClick={() => void operate('browser.resume')}>
          {t('恢复浏览器', 'Resume browser')}
        </button>}
    </span>}
    {failure !== null && <span className="browser-control-error" role="alert">{failure}</span>}
    {!readOnly && needsRefresh && <button type="button" className="mini chip" disabled={busy} onClick={() => void retryRefresh()}>{t('刷新状态', 'Refresh status')}</button>}
  </div>;
}
