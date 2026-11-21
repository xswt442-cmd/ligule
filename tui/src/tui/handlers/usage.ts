// 用量与请求诊断命令：/usage 输出 Host 的只读聚合与最近一次复审，/usage requests 管理本地请求诊断。
// TUI 不自己累加事件；会话记录读不到时如实报错，不把“读不到”说成“没有”。
import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type { Locale, UsageBucket, UsageSummary } from '@ligule/core/tui.js';
import type { TuiClient } from '../app.js';
import { errorCode } from '../error-text.js';
import { requestDiagnosticLines } from '../usage-lines.js';
import type { TranscriptItem } from '../transcript.js';

export type UsageCommandDeps = {
  readonly client: TuiClient;
  readonly projectRoot: string | undefined;
  readonly sessionId: string;
  readonly activeSession: MutableRefObject<string>;
  readonly push: (...items: TranscriptItem[]) => void;
  readonly t: (zh: string, en: string) => string;
  readonly locale: Locale;
};

export function useUsageCommands(deps: UsageCommandDeps): { handle: (name: string, argument: string) => boolean } {
  const { client, projectRoot, sessionId, activeSession, push, t, locale } = deps;

  const handle = useCallback((name: string, argument: string): boolean => {
    if (name !== 'usage') return false;
    const parts = argument.trim().split(/\s+/u).filter((part) => part !== '');
    if (parts[0] === 'requests') {
      const action = parts[1] ?? 'read';
      if (parts.length > 2 || !['read', 'on', 'off'].includes(action)) {
        push({ kind: 'error', text: t('用法：/usage requests [on|off]', 'Usage: /usage requests [on|off]') });
        return true;
      }
      const own = sessionId;
      void client.request('usage.diagnostics', {
        sessionId: own,
        action: action === 'on' ? 'enable' : action === 'off' ? 'disable' : 'read',
      }).then((diagnostics) => {
        if (activeSession.current !== own) return;
        if (action === 'on') {
          push({ kind: 'meta', text: t('本地请求诊断已开启；最多保留最近 32 次请求。', 'Local request diagnostics enabled; the last 32 requests are retained.') });
          return;
        }
        if (action === 'off') {
          push({ kind: 'meta', text: t('本地请求诊断已关闭并清空。', 'Local request diagnostics disabled and cleared.') });
          return;
        }
        if (!diagnostics.enabled) {
          push({ kind: 'meta', text: t('本地请求诊断未开启；运行 /usage requests on 后才开始收集。', 'Local request diagnostics are off; run /usage requests on to start collecting.') });
          return;
        }
        const lines = requestDiagnosticLines(diagnostics.entries, locale);
        push({ kind: 'meta', text: lines.length === 0 ? t('开启后还没有新的模型请求。', 'No model requests were sent after diagnostics were enabled.') : lines.join('\n\n') });
      }, (error: unknown) => {
        if (activeSession.current === own) push({ kind: 'error', text: t(
          `无法读取本地请求诊断：${errorCode(error) ?? 'request_diagnostics_failed'}`,
          `Could not read local request diagnostics: ${errorCode(error) ?? 'request_diagnostics_failed'}`,
        ) });
      });
      return true;
    }
    if (parts.length > 0) {
      push({ kind: 'error', text: t('用法：/usage [requests [on|off]]', 'Usage: /usage [requests [on|off]]') });
      return true;
    }
    // 用量按用途分开读：主机返回只读聚合，TUI 不自己累加事件。
    // 记录按会话所属项目定位：别的项目的会话不在本进程默认目录里。
    const root = projectRoot ?? '';
    void (async () => {
      const measured = await client.request('usage.get', root === '' ? { sessionId } : { sessionId, projectRoot: root })
        .catch((error: unknown) => ({ code: errorCode(error) ?? 'usage_read_failed' }));
      if (measured === null || typeof measured !== 'object' || 'code' in measured) {
        const code = measured !== null && typeof measured === 'object' && 'code' in measured
          ? String((measured as { code: unknown }).code) : 'usage_read_failed';
        push({ kind: 'error', text: t(`无法读取用量：${code}`, `Could not read usage: ${code}`) });
        return;
      }
      const summary = (measured as { summary?: UsageSummary }).summary;
      if (summary === undefined) {
        push({ kind: 'error', text: t('无法读取用量：返回里没有汇总', 'Could not read usage: the reply has no summary') });
        return;
      }
      const line = (label: string, bucket: UsageBucket): string => {
        if (bucket.requests === 0) return t(`${label}：暂无调用`, `${label}: no calls yet`);
        const input = bucket.unknownInputRequests === 0
          ? t(`输入 ${bucket.input}`, `input ${bucket.input}`)
          : t(`输入未知（${bucket.unknownInputRequests} 次未报）`, `input unknown (${bucket.unknownInputRequests} unreported)`);
        const output = bucket.unknownOutputRequests === 0
          ? t(`输出 ${bucket.output}`, `output ${bucket.output}`)
          : t(`输出未知（${bucket.unknownOutputRequests} 次未报）`, `output unknown (${bucket.unknownOutputRequests} unreported)`);
        const cached = bucket.cachedInput === 0 ? '' : t(`，其中缓存 ${bucket.cachedInput}`, ` (${bucket.cachedInput} cached)`);
        return t(`${label}：${bucket.requests} 次请求，${input}${cached}，${output}`, `${label}: ${bucket.requests} calls, ${input}${cached}, ${output}`);
      };
      // 最近一次复审也从会话记录里读，TUI 不自己推断裁决。
      // 外控会话由别的 Host 持有写入锁，`session.read` 会报 `session_not_open`；
      // 这时改用不取锁的 `session.observe`，并按 `before` 向更早的页翻，
      // 否则复审早于最新一页时，命令会把“存在但没翻到”说成“没有复审”。
      interface ReviewEvent { kind?: string; seq?: number; review?: string; reasonCode?: string; evidenceSeqs?: readonly number[] }
      // 分页预算上限：100 页 × 400 条足够覆盖常见会话；翻到上限就如实说“没查完”。
      const REVIEW_PAGE_LIMIT = 100;
      const readReviews = async (): Promise<{ reviews: readonly ReviewEvent[] } | { code: string } | { incomplete: true }> => {
        const direct = await client.request('session.read', { sessionId }).catch((error: unknown) => ({ code: errorCode(error) ?? 'session_read_failed' }));
        if (!('code' in direct)) {
          return { reviews: (direct.events as readonly ReviewEvent[]).filter((event) => event.kind === 'policyReview') };
        }
        let cursor: number | undefined;
        for (let page = 0; page < REVIEW_PAGE_LIMIT; page += 1) {
          const params: { projectRoot: string; sessionId: string; limit: number; before?: number } = {
            projectRoot: projectRoot ?? '', sessionId, limit: 400,
          };
          if (cursor !== undefined) params.before = cursor;
          const observed = await client.request('session.observe', params).catch((error: unknown) => ({ code: errorCode(error) ?? 'session_observe_failed' }));
          if ('code' in observed) return { code: observed.code };
          const events = observed.events as readonly ReviewEvent[];
          const found = events.filter((event) => event.kind === 'policyReview');
          if (found.length > 0) return { reviews: found };
          const oldest = events[0];
          // 空页或已经翻到 seq 1 才说明真的没有更早的记录；否则只是还没翻到。
          if (oldest?.seq === undefined || oldest.seq <= 1) return { reviews: [] };
          cursor = oldest.seq;
        }
        // 翻到页数上限仍未找到：结论是“没查完”，不是“没有复审”。
        return { incomplete: true };
      };
      const page = await readReviews();
      if (activeSession.current !== sessionId) return;
      const lines = [
        line(t('主 Agent', 'Agent'), summary.agent),
        line(t('复审', 'Reviewer'), summary.reviewer),
      ];
      // 记录读不出来时不能把“读不到”说成“没有复审”：用量那本账仍然照实显示，
      // 但复审这一行必须明确报错，否则用户会以为这段时间一次复审都没发生。
      if ('code' in page) {
        push({ kind: 'meta', text: lines.join('\n') });
        push({ kind: 'error', text: t(`无法读取会话记录，最近复审未知：${page.code}`, `Cannot read the session log, so the last review is unknown: ${page.code}`) });
        return;
      }
      // 翻到页数上限也没找到复审：只能报“没查完”，不能声称一次复审都没有。
      if ('incomplete' in page) {
        push({ kind: 'meta', text: lines.join('\n') });
        push({ kind: 'error', text: t(`查询未完成（已向前翻 ${REVIEW_PAGE_LIMIT} 页仍未找到复审），最近复审未知`, `The lookup stopped at its ${REVIEW_PAGE_LIMIT}-page limit, so the last review is unknown`) });
        return;
      }
      const last = page.reviews[page.reviews.length - 1];
      if (last?.review !== undefined) {
        const code = last.reasonCode ?? 'review_unspecified';
        const count = last.evidenceSeqs?.length ?? 0;
        lines.push(t(`最近复审：${last.review}（${code}，证据 ${count} 条）`, `Last review: ${last.review} (${code}, ${count} evidence items)`));
      }
      push({ kind: 'meta', text: lines.join('\n') });
    })();
    return true;
  }, [activeSession, client, locale, projectRoot, push, sessionId, t]);

  return { handle };
}
