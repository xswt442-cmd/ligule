// 会话记录维护命令：重命名、归档/取消归档，以及压缩上下文。
// 名称与归档状态由 Host 写入记录，TUI 不维护第二份副本。
import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type { TuiClient, TuiStatus } from '../app.js';
import { applyCompactionStatus, compactionStartAllowed } from '../compaction-status.js';
import { errorCode } from '../error-text.js';
import type { TranscriptItem } from '../transcript.js';

export type SessionMaintenanceCommandDeps = {
  readonly client: TuiClient;
  readonly sessionId: string;
  readonly activeSession: MutableRefObject<string>;
  readonly runningGeneration: MutableRefObject<number>;
  readonly setCompacting: (busy: boolean) => void;
  readonly compacting: boolean;
  readonly setSessionName: (name: string) => void;
  readonly setRunning: (running: boolean) => void;
  readonly setStatus: (next: TuiStatus | null) => void;
  readonly push: (...items: TranscriptItem[]) => void;
  readonly t: (zh: string, en: string) => string;
};

export function useSessionMaintenanceCommands(deps: SessionMaintenanceCommandDeps): { handle: (name: string, argument: string) => boolean } {
  const { client, sessionId, activeSession, runningGeneration, compacting, setCompacting, setSessionName, setRunning, setStatus, push, t } = deps;

  const handle = useCallback((name: string, argument: string): boolean => {
    if (name === 'rename' || name === 'archive' || name === 'unarchive') {
      // 会话名称和归档状态由 Host 写入记录，TUI 不维护第二份副本。
      const label = name === 'rename' ? { name: argument.trim() } : { archived: name === 'archive' };
      if (name === 'rename' && label.name === '') {
        push({ kind: 'error', text: t('请输入会话名称：/rename <名称>', 'Enter a session name: /rename <name>') });
        return true;
      }
      void (async () => {
        const own = sessionId;
        const done = await client.request('session.label', { sessionId: own, ...label }).catch((error: unknown) => ({ code: errorCode(error) ?? 'session_label_failed' }));
        // 等 Host 返回期间可能已切换会话：迟到的名称不得写进新前台。
        if (activeSession.current !== own) return;
        if ('code' in done) {
          push({ kind: 'error', text: t(`无法更新会话：${done.code}`, `Could not update session: ${done.code}`) });
          return;
        }
        setSessionName(done.name ?? '');
        push({ kind: 'meta', text: t(`${done.name || '未命名会话'} · ${done.archived ? '已归档' : '未归档'}`, `${done.name || 'Untitled session'} · ${done.archived ? 'archived' : 'not archived'}`) });
      })();
      return true;
    }
    if (name === 'compact') {
      if (!compactionStartAllowed(compacting)) {
        push({ kind: 'meta', text: t('压缩正在进行，完成后才能再次压缩。', 'Compaction is already running; wait for it to finish.') });
        return true;
      }
      void (async () => {
        const own = sessionId;
        setCompacting(true);
        try {
          // Host 负责调用模型生成摘要并写入检查点；TUI 显示成功或无法压缩的原因。
          const done = await client.request('session.compact', { sessionId: own }).catch((error: unknown) => ({ code: errorCode(error) ?? 'session_compact_failed' }));
          if (activeSession.current !== own) return;
          if ('code' in done) {
            push({ kind: 'error', text: t(`无法压缩上下文：${done.code}`, `Could not compact context: ${done.code}`) });
            return;
          }
          push({
            kind: 'meta',
            text: t(`已压缩记录 ${done.fromSeq}–${done.toSeq}：估算 token ${done.tokensBefore} → ${done.tokensAfter}，原文已保留`, `Compacted events ${done.fromSeq}–${done.toSeq}: estimated tokens ${done.tokensBefore} → ${done.tokensAfter}; original content preserved`),
          });
        } finally {
          if (activeSession.current !== own) { setCompacting(false); return; }
          // 运行标记以代次为准：读取期间若轮次状态已变化，旧响应不能把它覆盖回去。
          const generation = runningGeneration.current;
          const latest = await client.request('status.get', { sessionId: own }).catch(() => null);
          setCompacting(false);
          if (activeSession.current !== own) return;
          const outcome = applyCompactionStatus(generation, runningGeneration.current, latest);
          if (!outcome.apply) return;
          if (latest !== null) setStatus(latest);
          if (outcome.running !== undefined) setRunning(outcome.running);
        }
      })();
      return true;
    }
    return false;
  }, [activeSession, client, compacting, push, runningGeneration, sessionId, setCompacting, setRunning, setSessionName, setStatus, t]);

  return { handle };
}
