import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { HostExternalControlSnapshot, Locale, SessionEvent } from '@ligule/core/tui.js';
import type { QuestionState, TuiClient } from './app.js';
import { errorCode } from './error-text.js';
import { isAskQuestion } from './guards.js';
import { collectTranscriptPages } from './transcript-pages.js';
import type { TranscriptItem } from './transcript.js';

const TRANSCRIPT_PAGE_LIMIT = 50;
type LiveText = { text: string; reasoning: string };
type Setter<Value> = Dispatch<SetStateAction<Value>>;
type PendingApproval = { readonly id: string; readonly external?: boolean };

interface ExternalControlOptions<Approval extends PendingApproval> {
  readonly client: TuiClient;
  readonly enabled: boolean;
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly activeSession: RefObject<string>;
  readonly lastTranscriptSequence: RefObject<number>;
  readonly resolvedInteractions: RefObject<Set<string>>;
  readonly locale: Locale;
  readonly setSnapshot: Setter<HostExternalControlSnapshot | null>;
  readonly setModel: Setter<string | null>;
  readonly setLive: Setter<LiveText>;
  readonly setAsk: Setter<Approval | null>;
  readonly setQuery: Setter<QuestionState | null>;
  setRunning(running: boolean): void;
  appendObserved(events: readonly SessionEvent[]): boolean;
  dismissPanels(forApproval: boolean): void;
  makeApproval(id: string, details: unknown, locale: Locale, external: boolean): Approval;
  push(...rows: TranscriptItem[]): void;
  t(zh: string, en: string): string;
}

export function externalModelFrom(events: readonly SessionEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'turnContext' && typeof event.model === 'string' && event.model.trim() !== '') return event.model;
  }
  return null;
}

export function useExternalControl<Approval extends PendingApproval>({
  client, enabled, projectRoot, sessionId, activeSession, lastTranscriptSequence, resolvedInteractions, locale,
  setSnapshot, setModel, setLive, setAsk, setQuery, setRunning, appendObserved, dismissPanels, makeApproval, push, t,
}: ExternalControlOptions<Approval>): void {
  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    let operationId: string | null = null;
    let gapNotifiedOperationId: string | null = null;
    let lastFailure = '';
    let lastQuestionId = '';
    let lastApprovalId = '';
    const stale = () => disposed || activeSession.current !== sessionId;

    async function refreshTranscript() {
      const collected = await collectTranscriptPages(async (before) => {
        const observed = await client.request('session.observe', {
          projectRoot, sessionId, limit: 400, fullResults: true,
          ...(before === undefined ? {} : { before }),
        });
        return observed.events;
      }, lastTranscriptSequence.current, TRANSCRIPT_PAGE_LIMIT, stale);
      if (stale()) return;
      if (!appendObserved([...collected.pages].reverse().flat())) return;
      setModel(externalModelFrom(collected.pages[0] ?? []));
      if (!collected.complete) {
        push({ kind: 'error', text: t(
          `外控会话的记录超过 ${TRANSCRIPT_PAGE_LIMIT} 页仍未覆盖上次序号；更早的未读记录可能无法补齐`,
          `The external transcript gap spans more than ${TRANSCRIPT_PAGE_LIMIT} pages; earlier unseen records may stay incomplete`,
        ) });
      }
    }

    function requestTranscriptRefresh() {
      void refreshTranscript().catch((error: unknown) => {
        if (stale()) return;
        const code = errorCode(error) ?? 'session_observe_failed';
        push({ kind: 'error', text: t(`外控会话转录读取失败：${code}`, `Could not refresh external transcript: ${code}`) });
      });
    }

    async function poll() {
      if (stale()) return;
      let nextDelay = 1_000;
      try {
        const snapshot = await client.request('session.control', {
          projectRoot, sessionId, request: { action: 'status', after: cursor, limit: 50, waitMs: 10_000 },
        });
        if (stale()) return;
        const currentOperationId = snapshot.operationId ?? null;
        setSnapshot(snapshot);
        if (currentOperationId !== operationId) {
          operationId = currentOperationId;
          cursor = 0;
          gapNotifiedOperationId = null;
          nextDelay = 0;
          return;
        }
        setRunning(snapshot.state === 'running');
        for (const event of snapshot.events) {
          if (event.kind === 'model.delta' && (event.type === 'text' || event.type === 'reasoning') && typeof event.text === 'string') {
            const { type, text } = event;
            setLive(current => ({ ...current, [type]: current[type] + text }));
          }
          if (event.kind === 'session.event' && typeof event.eventKind === 'string') {
            if (event.eventKind === 'assistant') setLive(current => ({ ...current, text: '' }));
            if (event.eventKind === 'reasoning') setLive(current => ({ ...current, reasoning: '' }));
            requestTranscriptRefresh();
          }
        }
        if (snapshot.eventGap) {
          cursor = Math.max(0, (snapshot.firstAvailableCursor ?? cursor + 1) - 1);
          if (gapNotifiedOperationId !== operationId) {
            gapNotifiedOperationId = operationId;
            push({ kind: 'error', text: t(
              '外控实时事件出现缺口；正在刷新可用的持久会话记录，未写入记录的流式片段可能缺失。',
              'External live events have a gap. Persisted Session records are being refreshed; stream chunks not yet written to the Session may be missing.',
            ) });
          }
          requestTranscriptRefresh();
        }
        cursor = Math.max(cursor, snapshot.nextCursor);
        const question = snapshot.pendingInteractions.find(item => item.type === 'question'
          && !resolvedInteractions.current.has(item.requestId));
        const questions = question?.details.questions;
        if (question !== undefined && Array.isArray(questions) && questions.every(isAskQuestion)) {
          if (lastQuestionId !== question.requestId) {
            lastQuestionId = question.requestId;
            dismissPanels(false);
          }
          setQuery(current => current?.external === true && current.id === question.requestId
            ? current : { id: question.requestId, questions, at: 0, picked: {}, external: true });
        } else {
          lastQuestionId = '';
          setQuery(current => current?.external === true ? null : current);
        }
        const approval = snapshot.pendingInteractions.find(item => item.type === 'approval'
          && !resolvedInteractions.current.has(item.requestId));
        if (approval !== undefined) {
          if (lastApprovalId !== approval.requestId) {
            lastApprovalId = approval.requestId;
            dismissPanels(true);
          }
          setAsk(current => current?.external === true && current.id === approval.requestId
            ? current : makeApproval(approval.requestId, approval.details, locale, true));
        } else {
          lastApprovalId = '';
          setAsk(current => current?.external === true ? null : current);
        }
        lastFailure = '';
        nextDelay = snapshot.state === 'running' ? 0 : 1_000;
      } catch (error) {
        if (stale()) return;
        const code = errorCode(error) ?? 'external_control_failed';
        setRunning(false);
        if (lastFailure !== code) push({ kind: 'error', text: t(`外控会话不可用：${code}`, `External session unavailable: ${code}`) });
        lastFailure = code;
      } finally {
        if (!stale()) timer = setTimeout(() => { void poll(); }, nextDelay);
      }
    }
    void poll();
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); };
  }, [client, enabled, projectRoot, sessionId, activeSession, lastTranscriptSequence, resolvedInteractions, locale,
    setSnapshot, setModel, setLive, setAsk, setQuery, setRunning, appendObserved, dismissPanels, makeApproval, push, t]);
}
