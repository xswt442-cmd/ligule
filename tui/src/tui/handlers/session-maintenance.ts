// 会话记录维护命令：重命名、归档/取消归档，以及压缩上下文。
// 名称与归档状态由 Host 写入记录，TUI 不维护第二份副本。
import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type { TuiClient, TuiStatus } from '../app.js';
import { errorCode } from '../error-text.js';
import type { TranscriptItem } from '../transcript.js';

export type SessionMaintenanceCommandDeps = {
  readonly client: TuiClient;
  readonly sessionId: string;
  readonly activeSession: MutableRefObject<string>;
  readonly setSessionName: (name: string) => void;
  readonly setRunning: (running: boolean) => void;
  readonly setStatus: (next: TuiStatus | null) => void;
  readonly push: (...items: TranscriptItem[]) => void;
  readonly t: (zh: string, en: string) => string;
};

export function useSessionMaintenanceCommands(deps: SessionMaintenanceCommandDeps): { handle: (name: string, argument: string) => boolean } {
  const { client, sessionId, activeSession, setSessionName, setRunning, setStatus, push, t } = deps;

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
      void (async () => {
        const own = sessionId;
        setRunning(true);
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
          // 运行标记以 Host 当前状态为准：期间结束的轮次不能被压缩前的快照重新标成运行中。
          const latest = activeSession.current === own
            ? await client.request('status.get', { sessionId: own }).catch(() => null)
            : null;
          if (activeSession.current !== own) return;
          // 读取失败时保留现有状态，避免把仍在运行的轮次清成空闲。
          if (latest !== null) {
            setStatus(latest);
            setRunning(latest.running === true);
          }
        }
      })();
      return true;
    }
    return false;
  }, [activeSession, client, push, sessionId, setRunning, setSessionName, setStatus, t]);

  return { handle };
}
