// 会话列表与搜索命令：列表由 Host 扫描记录后交给选择器，搜索由 Host 返回会话与事件序号。
// TUI 不直接访问记录目录；异步结果要同时核对所属会话与选择器代次。
import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type { Locale, SessionSummary } from '@ligule/core/tui.js';
import type { TuiClient } from '../app.js';
import { findLines } from '../commands.js';
import { errorCode } from '../error-text.js';
import type { TranscriptItem } from '../transcript.js';

export type SessionPickerList = { readonly items: readonly SessionSummary[] };

export type SessionListCommandDeps = {
  readonly client: TuiClient;
  readonly projectRoot: string | undefined;
  readonly sessionId: string;
  readonly alive: MutableRefObject<boolean>;
  readonly activeSession: MutableRefObject<string>;
  readonly pickerRequest: MutableRefObject<number>;
  readonly setSessionPicker: (next: SessionPickerList | null) => void;
  readonly setDetail: (next: null) => void;
  readonly setExpanded: (next: boolean) => void;
  readonly setSearch: (next: null) => void;
  readonly push: (...items: TranscriptItem[]) => void;
  readonly t: (zh: string, en: string) => string;
  readonly locale: Locale;
};

export function useSessionListCommands(deps: SessionListCommandDeps): { handle: (name: string, argument: string) => boolean } {
  const { client, projectRoot, sessionId, alive, activeSession, pickerRequest, setSessionPicker, setDetail, setExpanded, setSearch, push, t, locale } = deps;

  const handle = useCallback((name: string, argument: string): boolean => {
    if (name === 'sessions') {
      const token = pickerRequest.current;
      const own = sessionId;
      void (async () => {
        // 会话列表由 Host 扫描，TUI 不直接访问记录目录。
        const listed = await client.request('sessions.list', { projectRoot }).catch((error: unknown) => ({ code: errorCode(error) ?? 'session_list_failed' }));
        if (!alive.current || activeSession.current !== own || pickerRequest.current !== token) return;
        if ('code' in listed) {
          push({ kind: 'error', text: t(`无法读取会话列表：${listed.code}`, `Could not list sessions: ${listed.code}`) });
          return;
        }
        if (listed.sessions.length === 0) push({ kind: 'meta', text: t('此工作区暂无会话', 'No sessions in this workspace') });
        else {
          setDetail(null);
          setExpanded(false);
          setSearch(null);
          setSessionPicker({ items: listed.sessions });
        }
      })();
      return true;
    }
    if (name === 'find') {
      const wanted = argument.trim();
      if (wanted === '') {
        push({ kind: 'meta', text: t('请输入搜索内容：/find <文字>', 'Enter search text: /find <text>') });
        return true;
      }
      void (async () => {
        // 搜索由 Host 扫描记录并返回会话和事件序号；TUI 不直接访问记录目录。
        // 搜索当前会话时读取溢出文件中的完整内容，跨会话搜索只检查记录内的文本。
        const [listed, deep] = await Promise.all([
          client.request('sessions.search', { query: wanted, projectRoot }).catch((error: unknown) => ({ code: errorCode(error) ?? 'session_search_failed' })),
          client.request('sessions.search', { query: wanted, sessionId }).catch((error: unknown) => ({ code: errorCode(error) ?? 'session_search_failed' })),
        ]);
        for (const answer of [listed, deep]) {
          if ('code' in answer) push({ kind: 'error', text: t(`搜索失败：${answer.code}`, `Search failed: ${answer.code}`) });
        }
        if ('code' in listed && 'code' in deep) return;
        const here = 'code' in deep ? [] : deep.hits;
        const others = 'code' in listed ? [] : listed.hits.filter((hit) => hit.sessionId !== sessionId);
        push({ kind: 'meta', text: here.length + others.length === 0
          ? t(`没有找到“${wanted}”`, `No results for “${wanted}”`)
          : [
            ...(here.length === 0 ? [] : [t('当前会话：', 'Current session:'), ...findLines(here, '', locale)]),
            ...(others.length === 0 ? [] : [t('其他会话：', 'Other sessions:'), ...findLines(others, sessionId, locale)]),
          ].join('\n') });
      })();
      return true;
    }
    return false;
  }, [activeSession, alive, client, locale, pickerRequest, projectRoot, push, sessionId, setDetail, setExpanded, setSearch, setSessionPicker, t]);

  return { handle };
}
