// 只读信息命令：当前工具清单与会话状态摘要。两者都只读取 Host 的 status.get，并同步界面状态。
import { useCallback } from 'react';
import type { Locale } from '@ligule/core/tui.js';
import type { TuiClient, TuiStatus } from '../app.js';
import { activeRunBudgetSegment, contextSegment } from '../status-line.js';
import type { TranscriptItem } from '../transcript.js';

export type InfoCommandDeps = {
  readonly client: TuiClient;
  readonly sessionId: string;
  readonly setStatus: (next: TuiStatus | null) => void;
  readonly push: (...items: TranscriptItem[]) => void;
  readonly t: (zh: string, en: string) => string;
  readonly locale: Locale;
};

export function useInfoCommands(deps: InfoCommandDeps): { handle: (name: string, argument: string) => boolean } {
  const { client, sessionId, setStatus, push, t, locale } = deps;

  const handle = useCallback((name: string): boolean => {
    if (name === 'tools') {
      void (async () => {
        const current = await client.request('status.get', { sessionId }).catch(() => null);
        setStatus(current);
        push({ kind: 'meta', text: current === null ? t('无法读取状态', 'Could not read status') : t(`工具：${current.tools.join('、')}`, `Tools: ${current.tools.join(', ')}`) });
      })();
      return true;
    }
    if (name === 'status') {
      void (async () => {
        const current = await client.request('status.get', { sessionId }).catch(() => null);
        setStatus(current);
        const context = contextSegment(current?.usage, locale);
        const permission = current?.permission === undefined ? '' : t(
          ` · 权限 ${current.permission.profile} · 网络 ${current.permission.network} · Shell ${current.permission.execution.available ? '可用' : `不可用（${current.permission.execution.code ?? '能力不足'}）`}`,
          ` · permission ${current.permission.profile} · network ${current.permission.network} · Shell ${current.permission.execution.available ? 'available' : `unavailable (${current.permission.execution.code ?? 'capability limits'})`}`,
        );
        const task = activeRunBudgetSegment(current, locale);
        push({ kind: 'meta', text: current === null ? t('无法读取状态', 'Could not read status')
          : t(`工具模式 ${current.mode ?? '-'} · 审批 ${current.policy} · 连续拒绝 ${current.denials.consecutive} / 累计 ${current.denials.total} · ${current.eventCount} 条记录`, `Mode ${current.mode ?? '-'} · approvals ${current.policy} · denials ${current.denials.consecutive} consecutive / ${current.denials.total} total · ${current.eventCount} events`)
            + permission + (context === '' ? '' : ` · ${context}`) + task });
      })();
      return true;
    }
    return false;
  }, [client, locale, push, sessionId, setStatus, t]);

  return { handle };
}
