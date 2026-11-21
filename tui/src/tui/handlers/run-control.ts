// 运行控制命令：界面队列的查看/暂停/继续/收回/清空，以及向当前运行追加输入。
// 队列是界面暂存，命令不修改会话记录；steer 通过 Host 协议把输入交给当前运行。
import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type { TuiClient, TuiStatus } from '../app.js';
import { errorCode } from '../error-text.js';
import { queuedLine } from '../queue-text.js';
import type { TranscriptItem } from '../transcript.js';

export type RunControlCommandDeps = {
  readonly client: TuiClient;
  readonly projectRoot: string | undefined;
  readonly sessionId: string;
  readonly activeSession: MutableRefObject<string>;
  readonly externalControl: boolean;
  readonly pendingQuestionId: string | undefined;
  readonly clearCancelledQuestion: (requestId: string, cancelled: number) => void;
  readonly queue: readonly string[];
  readonly queuePaused: boolean;
  readonly setQueue: (next: string[] | ((current: string[]) => string[])) => void;
  readonly setQueuePaused: (paused: boolean) => void;
  readonly activeQuestion: MutableRefObject<string | undefined>;
  readonly inputNow: MutableRefObject<{ readonly draft: string }>;
  readonly resetOrdinaryDraft: (text: string) => void;
  readonly push: (...items: TranscriptItem[]) => void;
  readonly t: (zh: string, en: string) => string;
};

export function useRunControlCommands(deps: RunControlCommandDeps): { handle: (name: string, argument: string) => boolean } {
  const { client, projectRoot, sessionId, activeSession, externalControl, pendingQuestionId, clearCancelledQuestion, queue, queuePaused, setQueue, setQueuePaused, activeQuestion, inputNow, resetOrdinaryDraft, push, t } = deps;

  const handle = useCallback((name: string, argument: string): boolean => {
    if (name === 'queue') {
      // 队列由界面暂存；此命令只负责继续发送或将消息收回草稿，不修改会话记录。
      const [action, ordinal] = argument.split(/\s+/);
      if (action === undefined || action === '' || action === 'list') {
        push({ kind: 'meta', text: queue.length === 0 ? t('队列为空', 'Queue is empty')
          : [
            t(`${queue.length} 条待发送（${queuePaused ? '已暂停；/queue continue 继续' : '本轮结束后依次发送'}）：`, `${queue.length} queued (${queuePaused ? 'paused; /queue continue to resume' : 'sends after this turn'}):`),
            ...queue.map((item, index) => `${index + 1} · ${queuedLine(item)}`),
          ].join('\n') });
        return true;
      }
      if (action === 'pause' || action === 'continue') {
        setQueuePaused(action === 'pause');
        push({ kind: 'meta', text: action === 'pause'
          ? t(`队列已暂停：${queue.length} 条待发送`, `Queue paused: ${queue.length} pending`)
          : queue.length === 0 ? t('队列为空', 'Queue is empty')
            : t(`队列已继续：${queue.length} 条待发送`, `Queue resumed: ${queue.length} pending`) });
        return true;
      }
      // 将收回的消息放回草稿，保留用户输入。
      // 命令已从草稿中移除，因此恢复后的草稿不会与命令文本拼接。
      if (action === 'drop') {
        const wanted = ordinal === undefined ? queue.length : Number(ordinal);
        const at = wanted - 1;
        if (!Number.isInteger(wanted) || at < 0 || at >= queue.length) {
          push({ kind: 'error', text: t(`队列编号无效，当前有 ${queue.length} 条消息`, `Invalid queue index; ${queue.length} messages queued`) });
          return true;
        }
        const recovered = [activeQuestion.current === undefined ? '' : inputNow.current.draft, queue[at]].filter(Boolean).join('\n\n');
        setQueue((current) => current.filter((_, index) => index !== at));
        resetOrdinaryDraft(recovered);
        push({ kind: 'meta', text: t(`消息 ${at + 1} 已移回草稿`, `Message ${at + 1} moved back to draft`) });
        return true;
      }
      if (action === 'clear') {
        if (queue.length === 0) {
          push({ kind: 'meta', text: t('队列为空', 'Queue is empty') });
          return true;
        }
        const recovered = [activeQuestion.current === undefined ? '' : inputNow.current.draft, ...queue].filter(Boolean).join('\n\n');
        setQueue([]);
        setQueuePaused(false);
        resetOrdinaryDraft(recovered);
        push({ kind: 'meta', text: t(`已将 ${queue.length} 条消息移回草稿`, `Moved ${queue.length} messages back to draft`) });
        return true;
      }
      push({ kind: 'error', text: t('用法：/queue list|pause|continue|drop <序号>|clear', 'Usage: /queue list|pause|continue|drop <n>|clear') });
      return true;
    }
    if (name === 'steer') {
      const input = argument.trim();
      if (input === '') {
        push({ kind: 'error', text: t('用法：/steer <文字>', 'Usage: /steer <text>') });
        return true;
      }
      void (async () => {
        const own = sessionId;
        try {
          const current = externalControl
            ? await client.request('session.control', {
              projectRoot: projectRoot ?? '', sessionId: own, request: { action: 'configuration' },
            }) as unknown as TuiStatus
            : await client.request('status.get', { sessionId: own });
          if (activeSession.current !== own) return;
          const runId = current.activeRunId;
          if (typeof runId !== 'string' || runId === '') {
            throw Object.assign(new Error('run_not_running'), { code: 'run_not_running' });
          }
          const accepted = externalControl
            ? await client.request('session.control', {
              projectRoot: projectRoot ?? '', sessionId: own, request: { action: 'steer', runId, input },
            })
            : await client.request('run.steer', { sessionId: own, runId, input });
          // 结果只写给发起时的前台会话，避免切换后污染新会话的卡片与提示。
          if (activeSession.current !== own) return;
          const pendingCount = typeof accepted.pendingCount === 'number' ? accepted.pendingCount : 0;
          const cancelledInteractions = typeof accepted.cancelledInteractions === 'number' ? accepted.cancelledInteractions : 0;
          if (cancelledInteractions > 0 && pendingQuestionId !== undefined) {
            clearCancelledQuestion(pendingQuestionId, cancelledInteractions);
          }
          push({ kind: 'meta', text: t(
            `输入已加入当前运行，待应用 ${pendingCount} 条${cancelledInteractions > 0 ? `；已取消 ${cancelledInteractions} 个等待答复` : ''}`,
            `Input added to the active run; ${pendingCount} pending${cancelledInteractions > 0 ? `; cancelled ${cancelledInteractions} pending interactions` : ''}`,
          ) });
        } catch (error) {
          push({ kind: 'error', text: t(`当前运行未收到输入：${errorCode(error) ?? 'run_steer_failed'}`, `The active run did not receive the input: ${errorCode(error) ?? 'run_steer_failed'}`) });
        }
      })();
      return true;
    }
    return false;
  }, [activeQuestion, activeSession, clearCancelledQuestion, client, externalControl, inputNow, pendingQuestionId, projectRoot, push, queue, queuePaused, resetOrdinaryDraft, sessionId, setQueue, setQueuePaused, t]);

  return { handle };
}
