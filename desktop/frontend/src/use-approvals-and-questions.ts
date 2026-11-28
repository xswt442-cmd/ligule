import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { approvalDisplaySession, approvalSession, toApprovalAsk, type ApprovalRequestParams } from './approval-request';
import type { Ask } from './components/ApprovalCard';
import type { QuestionAsk, QuestionDrafts } from './components/QuestionCard';
import type { NotificationKind } from './notifications';
import { code, type Client, type Frame } from './protocol';
import { changeBody, changeOf, metaRow, questionEcho, type Row } from './rows';

export function useApprovalsAndQuestions(
  client: Client, sessionId: string | null, active: RefObject<string | null>,
  composer: RefObject<HTMLTextAreaElement | null>, setRows: Dispatch<SetStateAction<Row[]>>,
) {
  const [asks, setAsks] = useState<Ask[]>([]);
  const [queries, setQueries] = useState<QuestionAsk[]>([]);
  const asksLeft = useRef<Ask[]>([]);
  const queriesLeft = useRef<QuestionAsk[]>([]);
  useEffect(() => { asksLeft.current = asks; }, [asks]);
  useEffect(() => { queriesLeft.current = queries; }, [queries]);
  const questionDrafts = useRef(new Map<string, QuestionDrafts>());
  const pendingEchoes = useRef(new Map<string, Array<{ zh: string; en: string }>>());

  const receive = useCallback((message: Frame, notify: (kind: NotificationKind, owner: string, root: string) => void) => {
    if (message.method === 'question.request') {
      const asked = message.params as { sessionId?: string; projectRoot?: string; questions?: QuestionAsk['questions'] };
      if (typeof asked?.sessionId !== 'string' || asked.sessionId === '' || !Array.isArray(asked.questions)) return;
      const id = message.id ?? '';
      const owner = asked.sessionId;
      const project = asked.projectRoot ?? '';
      const questions = asked.questions;
      if (!queriesLeft.current.some(one => one.id === id)) notify('question', owner, project);
      setQueries(current => current.some(one => one.id === id) ? current : [...current, { id, sessionId: owner, project, questions }]);
      return;
    }
    if (message.method !== 'approval.request') return;
    const params = message.params as ApprovalRequestParams | undefined;
    const owner = approvalSession(params);
    if (owner === null || params === undefined) return;
    notify('approval', approvalDisplaySession(params) ?? owner, params.projectRoot ?? '');
    const ask = toApprovalAsk(message.id ?? '', params);
    setAsks(current => [...current, ask]);
  }, []);

  const keepQuestionDraft = useCallback((id: string, drafts: QuestionDrafts) => {
    questionDrafts.current.set(id, drafts);
  }, []);
  const takeEchoes = useCallback((id: string) => {
    const kept = pendingEchoes.current.get(id) ?? [];
    pendingEchoes.current.delete(id);
    return kept;
  }, []);
  const outstandingApprovals = useCallback((id: string) => asksLeft.current.filter(ask => ask.sessionId === id).length, []);
  const dropAsksOf = useCallback((id: string) => setAsks(current => current.filter(ask => ask.sessionId !== id)), []);
  const dropQueriesOf = useCallback((id: string, reason: string) => {
    const left = queriesLeft.current.filter(one => one.sessionId === id);
    if (left.length === 0) return;
    const reasonEnglish = reason === '宿主换了一具' ? 'The host restarted' : 'The turn ended';
    const lines = left.map(one => {
      const drafts = questionDrafts.current.get(one.id);
      return {
        zh: `${questionEcho(one, drafts)}（${reason}，问题已结束）`,
        en: `${questionEcho(one, drafts, 'en')} (${reasonEnglish}; the question is closed)`,
      };
    });
    if (active.current === id) setRows(current => [...current,
      metaRow('meta', lines.map(line => line.zh).join('\n'), lines.map(line => line.en).join('\n'))]);
    else pendingEchoes.current.set(id, [...(pendingEchoes.current.get(id) ?? []), ...lines]);
    for (const one of left) questionDrafts.current.delete(one.id);
    setQueries(current => current.filter(one => one.sessionId !== id));
  }, [active, setRows]);
  const resetInteractions = useCallback(() => {
    setAsks([]);
    for (const owner of new Set(queriesLeft.current.map(one => one.sessionId))) dropQueriesOf(owner, '宿主换了一具');
  }, [dropQueriesOf]);

  const loadApprovalDetails = useCallback(async (ask: Ask) => {
    if (ask.detailsRef === undefined || ask.detailsLoaded === true || ask.detailsLoading === true) return;
    setAsks(current => current.map(item => item.id === ask.id ? { ...item, detailsLoading: true, detailsError: undefined } : item));
    try {
      const result = await client.call('approval.details', { sessionId: ask.sessionId, requestId: ask.detailsRef }, 15_000) as { args?: unknown };
      if (typeof result.args !== 'object' || result.args === null || Array.isArray(result.args)) throw new Error('approval_details_invalid');
      const args = result.args as Record<string, unknown>;
      const change = changeOf(ask.tool, args);
      const englishChange = changeOf(ask.tool, args, 'en');
      setAsks(current => current.map(item => item.id === ask.id ? {
        ...item, change: change.summary, content: `${changeBody(change, args)}${item.detailsSuffix?.chinese ?? ''}`,
        english: { change: englishChange.summary, content: `${changeBody(englishChange, args, 'en')}${item.detailsSuffix?.english ?? ''}` },
        detailsLoading: false, detailsLoaded: true,
      } : item));
    } catch (error) {
      const failure = code(error);
      setAsks(current => current.map(item => item.id === ask.id ? { ...item, detailsLoading: false, detailsError: failure } : item));
    }
  }, [client]);

  const focusComposer = useCallback(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    composer.current?.focus();
  }, [composer]);
  const answer = useCallback((decision: 'allow' | 'deny', rememberScope?: 'session' | 'project' | 'user', rememberTarget?: 'file' | 'workspace' | 'tool' | 'command') => {
    const head = asks.find(ask => (ask.displaySessionId ?? ask.sessionId) === sessionId);
    if (head === undefined) return;
    setAsks(current => current.filter(ask => ask.id !== head.id));
    client.reply(head.id, { decision, ...(rememberScope === undefined ? {} : { rememberScope }), ...(rememberTarget === undefined ? {} : { rememberTarget }) });
    focusComposer();
  }, [asks, client, focusComposer, sessionId]);
  const answerQuestion = useCallback((answers: { id: string; selected: string[]; custom?: string }[]) => {
    const head = queries.find(query => query.sessionId === sessionId);
    if (head === undefined) return;
    setQueries(current => current.filter(query => query.id !== head.id));
    questionDrafts.current.delete(head.id);
    setRows(current => [...current, metaRow('meta', `${answers.length}/${head.questions.length} 个问题已回答，其余已标记为未回答。`,
      `${answers.length} of ${head.questions.length} questions answered; the rest were marked unanswered.`)]);
    client.reply(head.id, { answers });
    focusComposer();
  }, [client, focusComposer, queries, sessionId, setRows]);

  return {
    asks, queries, questionDrafts, receive, keepQuestionDraft, takeEchoes, outstandingApprovals,
    dropAsksOf, dropQueriesOf, resetInteractions, loadApprovalDetails, answer, answerQuestion,
  };
}
