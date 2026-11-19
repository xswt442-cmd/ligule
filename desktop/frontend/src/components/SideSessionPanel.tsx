import { useCallback, useEffect, useRef, useState } from 'react';
import type { Client } from '../protocol';
import { code } from '../protocol';
import { useText } from '../locale';
import { object } from '../guards.ts';

type SideOrigin = {
  readonly sourceKind: 'event' | 'file' | 'diff';
  readonly sourceEventSeq?: number;
  readonly sourcePath?: string;
  readonly sourceVersion?: string;
  readonly selectionBytes: number;
  readonly sourceRunId?: string;
};

export function SideSessionPanel({ client, sessionId, projectRoot, sideSessionId, originSessionId,
  onOpenOrigin, onOpenSideSession, onSendToRun, onPrepareFollowup }: {
  readonly client: Client;
  readonly sessionId: string | null;
  readonly projectRoot: string;
  readonly sideSessionId: string;
  readonly originSessionId: string;
  readonly onOpenOrigin: (sessionId: string) => void;
  readonly onOpenSideSession: (sessionId: string) => void;
  readonly onSendToRun: (sessionId: string, runId: string, text: string, projectRoot: string) => Promise<void>;
  readonly onPrepareFollowup: (sessionId: string, text: string, projectRoot: string) => Promise<void>;
}) {
  const t = useText();
  const generation = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const [origin, setOrigin] = useState<SideOrigin | null>(null);
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [originRunStale, setOriginRunStale] = useState(false);

  useEffect(() => {
    const own = ++generation.current;
    setOrigin(null);
    setAnswer('');
    setError(null);
    setResult(null);
    setLoading(true);
    void (async () => {
      await client.call('session.open', { sessionId: sideSessionId, ...(projectRoot === '' ? {} : { projectRoot }) }, 15_000);
      const record = await client.call('session.read', { sessionId: sideSessionId, limit: 1000, fullResults: true }, 15_000) as { events?: Record<string, unknown>[] };
      const events = Array.isArray(record.events) ? record.events : [];
      const linked = events.find(event => event.kind === 'sideSessionOrigin'
        && event.ignorable === true && event.originSessionId === originSessionId);
      if (!object(linked) || !['event', 'file', 'diff'].includes(String(linked.sourceKind))
        || !Number.isSafeInteger(linked.selectionBytes) || Number(linked.selectionBytes) < 1 || Number(linked.selectionBytes) > 8192) {
        throw Object.assign(new Error('side_session_origin_unavailable'), { code: 'side_session_origin_unavailable' });
      }
      const latest = [...events].reverse().find((event: Record<string, unknown>) => event.kind === 'assistant' && typeof event.text === 'string');
      if (generation.current !== own) return;
      setOrigin({
        sourceKind: linked.sourceKind as SideOrigin['sourceKind'],
        ...(Number.isSafeInteger(linked.sourceEventSeq) ? { sourceEventSeq: Number(linked.sourceEventSeq) } : {}),
        ...(typeof linked.sourcePath === 'string' ? { sourcePath: linked.sourcePath } : {}),
        ...(typeof linked.sourceVersion === 'string' ? { sourceVersion: linked.sourceVersion } : {}),
        selectionBytes: Number(linked.selectionBytes),
        ...(typeof linked.originRunId === 'string' ? { sourceRunId: linked.originRunId } : {}),
      });
      setAnswer(typeof latest?.text === 'string' ? latest.text.slice(0, 8_192) : '');
    })().catch(cause => {
      if (generation.current === own) setError(code(cause));
    }).finally(() => {
      if (generation.current === own) setLoading(false);
    });
    return () => { generation.current += 1; };
  }, [client, originSessionId, projectRoot, refresh, sideSessionId]);

  useEffect(() => client.onNotification(message => {
    if (message.notify === 'event' && message.sessionId === sideSessionId) setRefresh(value => value + 1);
  }), [client, sideSessionId]);

  const sendToRun = useCallback(async () => {
    if (origin?.sourceRunId === undefined || answer.trim() === '' || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      await onSendToRun(originSessionId, origin.sourceRunId, answer.trim(), projectRoot);
      setResult(t('已发送到原 Run 的 steering 输入。', 'Sent as steering to the original Run.'));
    } catch (cause) {
      const failure = code(cause);
      setError(failure);
      if (failure === 'side_chat_origin_run_stale') setOriginRunStale(true);
    }
    finally { setBusy(false); }
  }, [answer, busy, onSendToRun, origin, originSessionId, projectRoot, t]);

  const prepareFollowup = useCallback(async () => {
    if (answer.trim() === '' || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      await onPrepareFollowup(originSessionId, answer.trim(), projectRoot);
      setResult(t('内容已放入来源会话输入框，请检查后发送。', 'The text is in the source conversation composer. Review and send it there.'));
    } catch (cause) { setError(code(cause)); }
    finally { setBusy(false); }
  }, [answer, busy, onPrepareFollowup, originSessionId, projectRoot, t]);

  const sourceLabel = origin === null ? t('读取来源…', 'Loading source…')
    : origin.sourceKind === 'event' ? t(`事件 ${origin.sourceEventSeq ?? '未知'}`, `Event ${origin.sourceEventSeq ?? 'unknown'}`)
      : origin.sourceKind === 'file' ? `${origin.sourcePath ?? 'unknown'} · ${origin.sourceVersion ?? 'unknown'}`
        : t(`差异 ${origin.sourcePath ?? '未知'}`, `Diff ${origin.sourcePath ?? 'unknown'}`);

  return <section className="side-session-panel" aria-label={t('侧聊来源', 'Side chat source')}>
    <header>
      <div><h3>{t('侧面询问', 'Side conversation')}</h3><p>{t('普通独立会话 · 默认只读', 'Regular independent Session · read-only by default')}</p></div>
      <button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>{t('刷新', 'Refresh')}</button>
    </header>
    <dl>
      <dt>{t('来源会话', 'Source Session')}</dt><dd>{originSessionId}</dd>
      <dt>{t('选中材料', 'Selected material')}</dt><dd>{sourceLabel}</dd>
      <dt>{t('材料大小', 'Selection size')}</dt><dd>{origin?.selectionBytes ?? '—'} {t('字节', 'bytes')}</dd>
      {origin?.sourceRunId !== undefined && <><dt>{t('目标 Run', 'Target Run')}</dt><dd>{origin.sourceRunId}</dd></>}
    </dl>
    <div className="side-session-actions">
      <button type="button" disabled={sessionId === sideSessionId} onClick={() => onOpenSideSession(sideSessionId)}>
        {t('打开侧聊会话', 'Open side Session')}
      </button>
      <button type="button" disabled={sessionId === originSessionId} onClick={() => onOpenOrigin(originSessionId)}>
        {t('返回来源会话', 'Open source Session')}
      </button>
    </div>
    {origin !== null && <>
      <label className="side-session-answer">
        {t('准备发回的结论', 'Conclusion to send back')}
        <textarea maxLength={8_192} value={answer} onChange={event => setAnswer(event.currentTarget.value)} />
      </label>
      {origin.sourceRunId !== undefined && !originRunStale
        ? <button type="button" disabled={busy || answer.trim() === ''} onClick={() => void sendToRun()}>
          {busy ? t('正在发送…', 'Sending…') : t('发送到原 Run', 'Send to original Run')}
        </button>
        : <button type="button" disabled={busy || answer.trim() === ''} onClick={() => void prepareFollowup()}>
          {busy ? t('正在准备…', 'Preparing…') : t('作为来源会话后续', 'Prepare source follow-up')}
        </button>}
    </>}
    {loading && <p role="status">{t('正在读取侧聊来源…', 'Reading side chat source…')}</p>}
    {result !== null && <p role="status">{result}</p>}
    {error !== null && <p role="alert">{error}</p>}
  </section>;
}
