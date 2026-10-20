import { useEffect, useState } from 'react';
import { ApprovalCard, type Ask } from './ApprovalCard';
import { QuestionCard, type QuestionAsk, type QuestionDrafts } from './QuestionCard';
import { Modal } from './ui';
import type { Verbosity } from './types';
import { code, type Client } from '../protocol';
import { useText } from '../locale';

type PendingInteraction = {
  requestId: string;
  sessionId: string;
  type: 'approval' | 'question';
  details: Record<string, unknown>;
};

type ControlEvent = {
  kind: string;
  eventKind?: string;
  type?: 'text' | 'reasoning';
  text?: string;
};

type ControlSnapshot = {
  operationId?: string;
  sessionId: string;
  state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  ownership: 'external' | 'human';
  phase: string | null;
  progress: { modelCalls: number; toolCalls: number; lastProgressAt: number } | null;
  pendingInteractions: PendingInteraction[];
  events: ControlEvent[];
  nextCursor: number;
  eventGap: boolean;
  firstAvailableCursor: number;
  queue: { queueItemId: string; inputCharacters: number; source: 'human' | 'controller' }[];
};

function questionOf(item: PendingInteraction, project: string): QuestionAsk {
  const details = item.details;
  return {
    id: item.requestId,
    sessionId: item.sessionId,
    project,
    questions: details.questions as QuestionAsk['questions'],
  };
}

function approvalOf(item: PendingInteraction, project: string): Ask {
  const details = item.details;
  return {
    id: item.requestId,
    sessionId: item.sessionId,
    project,
    tool: typeof details.tool === 'string' ? details.tool : 'unknown',
    detail: typeof details.command === 'string' ? details.command : '',
    change: '',
    reason: typeof details.reason === 'string' ? details.reason : '',
    backend: typeof details.executable === 'string' ? details.executable : typeof details.shell === 'string' ? details.shell : '',
    policy: typeof details.policy === 'string' ? details.policy : '',
    policySource: typeof details.policySource === 'string' ? details.policySource : '',
    policyForced: details.policyForced === true,
    content: JSON.stringify(details.args ?? {}, null, 2) ?? '',
  };
}

export function ExternalSessionControlPanel({ client, sessionId, projectRoot, verbosity, onDelta, onSessionEvent, onTakeover }: {
  client: Client;
  sessionId: string;
  projectRoot: string;
  verbosity: Verbosity;
  onDelta: (kind: 'text' | 'reasoning', text: string) => void;
  onSessionEvent: (kind: string) => void;
  onTakeover: () => void;
}) {
  const t = useText();
  const [snapshot, setSnapshot] = useState<ControlSnapshot | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [confirmTakeover, setConfirmTakeover] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    let operationId: string | null = null;
    let inFlight = false;
    const schedule = (delayMs: number) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void poll(); }, delayMs);
    };
    const poll = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      let waitMs = 0;
      try {
        const result = await client.call('session.control', {
          projectRoot,
          sessionId,
          request: { action: 'status', after: cursor, limit: 50, waitMs: 10_000 },
        }, 35_000) as ControlSnapshot;
        if (disposed) return;
        const nextOperationId = result.operationId ?? null;
        if (nextOperationId !== operationId) {
          operationId = nextOperationId;
          cursor = 0;
          if (nextOperationId !== null) {
            waitMs = 0;
            schedule(0);
            return;
          }
        }
        if (result.eventGap) {
          cursor = Math.max(0, result.firstAvailableCursor - 1);
          setNote({ text: t('部分实时更新已滚出事件窗口；转录记录仍可刷新查看。', 'Some live updates left the event window; refresh the transcript to review saved records.'), bad: false });
          waitMs = 0;
        }
        for (const event of result.events) {
          if (event.kind === 'model.delta' && event.type !== undefined && typeof event.text === 'string') onDelta(event.type, event.text);
          else if (event.kind === 'session.event' && typeof event.eventKind === 'string') onSessionEvent(event.eventKind);
        }
        cursor = Math.max(cursor, result.nextCursor);
        setSnapshot(result);
        setNote((current) => current?.bad === true ? null : current);
        waitMs = result.state === 'running' ? 0 : 1_000;
      } catch (error) {
        if (!disposed) {
          setNote({ text: t(`外控连接暂不可用：${code(error)}`, `External control is unavailable: ${code(error)}`), bad: true });
          waitMs = 1_000;
        }
      } finally {
        inFlight = false;
        if (!disposed && timer === undefined) schedule(waitMs);
      }
    };
    void poll();
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); };
  }, [client, onDelta, onSessionEvent, projectRoot, sessionId, t]);

  async function act(request: Record<string, unknown>): Promise<unknown> {
    return await client.call('session.control', { projectRoot, sessionId, request }, 35_000);
  }

  async function send(): Promise<void> {
    if (draft.trim() === '' || busy) return;
    setBusy(true);
    try {
      const result = await act({ action: 'send', input: draft }) as { queued?: boolean };
      setDraft('');
      setNote({
        text: result.queued === true
          ? t('消息已加入外控会话队列。', 'Message queued for the external session.')
          : t('消息已发送到外控会话。', 'Message sent to the external session.'),
        bad: false,
      });
    } catch (error) {
      setNote({ text: t(`消息未发送：${code(error)}`, `Message was not sent: ${code(error)}`), bad: true });
    } finally { setBusy(false); }
  }

  async function reply(item: PendingInteraction, answer: Record<string, unknown>): Promise<void> {
    setBusy(true);
    try {
      await act({ action: 'reply', requestId: item.requestId, type: item.type, ...answer });
      setNote({ text: t('已将答复交给外控会话。', 'Answer sent to the external session.'), bad: false });
    } catch (error) {
      setNote({ text: t(`答复未提交：${code(error)}`, `Answer was not submitted: ${code(error)}`), bad: true });
    } finally { setBusy(false); }
  }

  async function cancel(): Promise<void> {
    setBusy(true);
    try {
      await act({ action: 'cancel' });
      setNote({ text: t('已请求停止外控会话当前轮次。', 'Requested cancellation of the active external turn.'), bad: false });
    } catch (error) {
      setNote({ text: t(`停止请求失败：${code(error)}`, `Could not stop the run: ${code(error)}`), bad: true });
    } finally { setBusy(false); }
  }

  async function takeOver(): Promise<void> {
    setBusy(true);
    try {
      await act({ action: 'takeover' });
      setConfirmTakeover(false);
      onTakeover();
    } catch (error) {
      setNote({ text: t(`接管失败：${code(error)}`, `Could not take over: ${code(error)}`), bad: true });
    } finally { setBusy(false); }
  }

  const pending = snapshot?.pendingInteractions ?? [];
  const project = projectRoot.split(/[\\/]/u).filter(Boolean).at(-1) ?? '';
  const phase = snapshot?.phase === 'awaiting_approval' ? t('等待审批', 'Waiting for approval')
    : snapshot?.phase === 'awaiting_input' ? t('等待回答', 'Waiting for an answer')
      : snapshot?.phase === 'model_request' ? t('正在请求模型', 'Requesting the model')
        : snapshot?.phase === 'tool_execution' ? t('正在执行工具', 'Running tools')
          : snapshot?.state === 'running' ? t('运行中', 'Running')
            : snapshot?.state === 'failed' ? t('运行失败', 'Run failed')
              : snapshot?.state === 'cancelled' ? t('已停止', 'Stopped')
                : t('等待外控任务', 'Waiting for an external task');

  return <section className="external-control" aria-label={t('外控会话控制', 'External session controls')}>
    <div className="external-control-head">
      <strong>{t('外控会话', 'External session')}</strong>
      <span className="external-control-state" role="status">{phase}</span>
      {snapshot?.progress !== null && snapshot?.progress !== undefined && snapshot.state === 'running'
        && <span className="external-control-metrics">{snapshot.progress.modelCalls} {t('次模型调用', 'model calls')} · {snapshot.progress.toolCalls} {t('个工具调用', 'tool calls')}</span>}
      {snapshot?.state === 'running' && <button type="button" disabled={busy} onClick={() => void cancel()}>{t('停止本轮', 'Stop turn')}</button>}
      <button type="button" disabled={busy} onClick={() => setConfirmTakeover(true)}>{t('接管会话', 'Take over')}</button>
    </div>
    {note !== null && <p className={note.bad ? 'external-control-note bad' : 'external-control-note'} role={note.bad ? 'alert' : 'status'}>{note.text}</p>}
    {pending.map((item) => item.type === 'question'
      ? <QuestionCard
          key={item.requestId}
          ask={questionOf(item, project)}
          queued={pending.length - 1}
          active={sessionId}
          onSubmit={(answers) => void reply(item, { answers })}
          onCancel={() => void cancel()}
          onOpen={() => undefined}
          onDraft={(_id: string, _drafts: QuestionDrafts) => undefined}
        />
      : <ApprovalCard
          key={item.requestId}
          ask={approvalOf(item, project)}
          queued={pending.length - 1}
          verbosity={verbosity}
          active={sessionId}
          onAnswer={(decision) => void reply(item, { decision })}
          onOpen={() => undefined}
        />)}
    <div className="external-control-compose">
      <textarea
        value={draft}
        rows={1}
        aria-label={t('发送消息到外控会话', 'Send a message to the external session')}
        placeholder={t('给外控 Agent 补充信息', 'Send guidance to the external agent')}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey) return;
          event.preventDefault();
          void send();
        }}
      />
      <button type="button" disabled={busy || draft.trim() === ''} onClick={() => void send()}>{t('发送', 'Send')}</button>
    </div>
    {confirmTakeover && <Modal title={t('接管外控会话', 'Take over external session')} className="confirm" onClose={() => setConfirmTakeover(false)}>
      <h2 className="confirm-lead">{t('停止外控并将会话交给 Desktop？', 'Stop external control and give this session to Desktop?')}</h2>
      <p className="confirm-note">{t('当前轮次会先取消，等待中的外控队列会清空。已经写入工作区的文件不会回滚。', 'The active turn will be cancelled and queued external messages cleared. Workspace changes already made will remain.')}</p>
      <div className="confirm-actions">
        <button type="button" disabled={busy} onClick={() => setConfirmTakeover(false)}>{t('继续观察', 'Keep observing')}</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void takeOver()}>{t('接管', 'Take over')}</button>
      </div>
    </Modal>}
  </section>;
}
