// Side chat 的界面状态与异步创建：捕获选区、打开确认框、调用 Host 创建 side session 并切换前台。
// 选区与目标会话绑定；创建期间的旧响应不会覆盖已切换的前台会话（由 openSession 的身份校验负责）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { code, type Client } from './protocol';
import { MAX_SIDE_CHAT_CONTEXT_BYTES, sideChatContextBytes, sideChatPrompt, type SideChatSelection } from './side-chat';
import type { Status } from './status';

export type SideChatController = {
  readonly selection: SideChatSelection | null;
  readonly dialog: SideChatSelection | null;
  readonly question: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly openDialog: () => void;
  readonly closeDialog: () => void;
  readonly setQuestion: (value: string) => void;
  readonly create: () => Promise<void>;
};

export function useSideChat(deps: {
  client: Client;
  sessionId: string | null;
  projectRoot: string;
  status: Status | null;
  openSession: (id: string, hit: undefined, reclaimQueue: boolean, askedRoot: string) => Promise<boolean | undefined>;
  openSideSessionResource: (sideSessionId: string, originSessionId: string, root: string) => void;
  setDraft: (text: string, owner: { root: string; id: string }) => void;
}): SideChatController {
  const { client, sessionId, projectRoot, status, openSession, openSideSessionResource, setDraft } = deps;
  const [selection, setSelection] = useState<SideChatSelection | null>(null);
  const [dialog, setDialog] = useState<SideChatSelection | null>(null);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 创建请求等待期间用户可能已切换前台：迟到的回执不能把前台强行切回 side 会话。
  const latestSession = useRef(sessionId);
  latestSession.current = sessionId;

  useEffect(() => {
    let frame = 0;
    const capture = () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (dialog !== null || sessionId === null || projectRoot === '') {
          setSelection(null);
          return;
        }
        const current = window.getSelection();
        const text = current?.toString().trim() ?? '';
        if (current === null || current.isCollapsed || current.rangeCount !== 1 || text === ''
          || sideChatContextBytes(text) > MAX_SIDE_CHAT_CONTEXT_BYTES) {
          setSelection(null);
          return;
        }
        const parentOf = (node: Node | null): Element | null => node instanceof Element ? node : node?.parentElement ?? null;
        const start = parentOf(current.anchorNode);
        const end = parentOf(current.focusNode);
        const source = start?.closest<HTMLElement>('[data-side-chat-kind]') ?? null;
        if (source === null || source !== end?.closest('[data-side-chat-kind]') || source.closest('.cm-editor') !== null) {
          setSelection(null);
          return;
        }
        let reference: SideChatSelection['source'] | undefined;
        if (source.dataset.sideChatKind === 'event') {
          const eventSeq = Number(source.dataset.sideChatSeq);
          if (Number.isSafeInteger(eventSeq) && eventSeq >= 0) reference = { kind: 'event', eventSeq };
        } else if (source.dataset.sideChatKind === 'file') {
          const path = source.dataset.sideChatPath;
          const version = source.dataset.sideChatVersion;
          if (typeof path === 'string' && typeof version === 'string' && /^[a-f0-9]{16}$/iu.test(version)) {
            reference = { kind: 'file', path, version };
          }
        } else if (source.dataset.sideChatKind === 'diff') {
          const path = source.dataset.sideChatPath;
          if (typeof path === 'string' && path !== '') reference = { kind: 'diff', path };
        }
        if (reference === undefined) {
          setSelection(null);
          return;
        }
        const bounds = current.getRangeAt(0).getBoundingClientRect();
        setSelection({ sessionId, projectRoot,
          ...(reference.kind !== 'event' && status?.running === true && status.activeRunId !== null
            && status.activeRunId !== undefined ? { sourceRunId: status.activeRunId } : {}),
          text, source: reference,
          left: Math.max(8, Math.min(window.innerWidth - 150, bounds.left)),
          top: Math.max(8, Math.min(window.innerHeight - 42, bounds.bottom + 6)),
        });
      });
    };
    document.addEventListener('selectionchange', capture);
    window.addEventListener('scroll', capture, true);
    window.addEventListener('resize', capture);
    return () => {
      document.removeEventListener('selectionchange', capture);
      window.removeEventListener('scroll', capture, true);
      window.removeEventListener('resize', capture);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [dialog, projectRoot, sessionId, status?.activeRunId, status?.running]);

  const create = useCallback(async () => {
    const context = dialog;
    const prompt = question.trim();
    const sourceSessionId = context?.sessionId ?? null;
    const root = context?.projectRoot ?? '';
    if (context === null || prompt === '' || sourceSessionId === null || root === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const request = {
        sessionId: sourceSessionId,
        sourceKind: context.source.kind,
        selection: context.text,
        ...(context.source.kind === 'event' ? { sourceEventSeq: context.source.eventSeq } : {
          sourcePath: context.source.path,
          ...(context.source.kind === 'file' ? { sourceVersion: context.source.version } : {}),
          ...(context.sourceRunId === undefined ? {} : { sourceRunId: context.sourceRunId }),
        }),
      };
      const created = await client.call('session.side.create', request, 30_000) as {
        sessionId?: string; sourceSessionId?: string;
      };
      if (typeof created.sessionId !== 'string' || created.sessionId === '' || created.sourceSessionId !== sourceSessionId) {
        throw Object.assign(new Error('side_session_response_invalid'), { code: 'side_session_response_invalid' });
      }
      const sourceLabel = context.source.kind === 'event' ? `Session event ${context.source.eventSeq}`
        : context.source.kind === 'file' ? `file ${context.source.path}` : `Git diff ${context.source.path}`;
      const promptText = sideChatPrompt(context.text, prompt, sourceLabel);
      // 用户已离开发起会话：不切换前台，但已创建的 Side 会话与草稿仍要保留。
      if (latestSession.current !== sourceSessionId) {
        setDraft(promptText, { root, id: created.sessionId });
        openSideSessionResource(created.sessionId, sourceSessionId, root);
        setDialog(null);
        setQuestion('');
        setSelection(null);
        return;
      }
      const opened = await openSession(created.sessionId, undefined, false, root);
      if (opened !== true) throw Object.assign(new Error('side_session_open_failed'), { code: 'side_session_open_failed' });
      setDraft(promptText, { root, id: created.sessionId });
      openSideSessionResource(created.sessionId, sourceSessionId, root);
      setDialog(null);
      setQuestion('');
      setSelection(null);
    } catch (failure) {
      setError(code(failure));
    } finally {
      setBusy(false);
    }
  }, [busy, client, dialog, openSession, openSideSessionResource, question, setDraft]);

  const openDialog = useCallback(() => {
    if (selection !== null) setDialog(selection);
  }, [selection]);
  const closeDialog = useCallback(() => {
    if (!busy) { setDialog(null); setError(null); }
  }, [busy]);

  return { selection, dialog, question, busy, error, openDialog, closeDialog, setQuestion, create };
}
