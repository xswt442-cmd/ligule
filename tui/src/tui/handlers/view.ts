// 视图与本地交互命令：复制最近回答、导出会话记录、查看单条记录。
// 复制读取已落盘记录后交给剪贴板；导出由 Host 排版并写入；查看只更新界面详情。
import { resolve } from 'node:path';
import { useCallback } from 'react';
import type { Locale } from '@ligule/core/tui.js';
import type { TuiClient } from '../app.js';
import { copyToClipboard, lastAnswer } from '../clipboard.js';
import { errorCode } from '../error-text.js';
import { findRecord } from '../record-find.js';
import { projectRecord, type TranscriptItem } from '../transcript.js';

export type DetailView = { readonly seq: number; readonly kind: string; readonly rows: TranscriptItem[] };

export type ViewCommandDeps = {
  readonly client: TuiClient;
  readonly sessionId: string;
  readonly push: (...items: TranscriptItem[]) => void;
  readonly t: (zh: string, en: string) => string;
  readonly locale: Locale;
  readonly setDetail: (next: DetailView | null) => void;
};

export function useViewCommands(deps: ViewCommandDeps): { handle: (name: string, argument: string) => boolean } {
  const { client, sessionId, push, t, locale, setDetail } = deps;

  const handle = useCallback((name: string, argument: string): boolean => {
    if (name === 'copy') {
      void (async () => {
        // 只复制记录中已落盘的最后一条回答，不复制尚未完成的流式片段。
        const read = await client.request('session.read', { sessionId }).catch((error: unknown) => ({ code: errorCode(error) ?? 'session_read_failed' }));
        if ('code' in read) {
          push({ kind: 'error', text: t(`无法读取记录：${read.code}`, `Could not read conversation: ${read.code}`) });
          return;
        }
        const answer = lastAnswer(read.events);
        if (answer === '') {
          push({ kind: 'meta', text: t('暂无可复制的回答', 'No answer to copy yet') });
          return;
        }
        const done = await copyToClipboard(answer);
        push('program' in done
          ? { kind: 'meta', text: t('已复制最近的回答', 'Latest answer copied') }
          : { kind: 'error', text: t(`复制失败：${done.code}`, `Copy failed: ${done.code}`) });
      })();
      return true;
    }
    if (name === 'export') {
      if (argument === '') {
        push({ kind: 'error', text: t('请指定导出路径：/export <路径>', 'Specify an export path: /export <path>') });
        return true;
      }
      void (async () => {
        // 排版和写入由 Host 完成；这里仅根据当前工作目录解析用户提供的目标路径。
        const done = await client.request('session.export', { sessionId, path: resolve(argument) }).catch((error: unknown) => ({ code: errorCode(error) ?? 'session_export_failed' }));
        if ('code' in done) {
          push({ kind: 'error', text: t(`导出失败：${done.code}`, `Export failed: ${done.code}`) });
          return;
        }
        // 区分派生会话记录读取失败和目标文件已存在两种无法导出的情况。
        for (const item of done.skipped) {
          push({ kind: 'error', text: item.code === 'export_target_exists'
            ? t(`文件已存在，已跳过：${item.path ?? item.id}`, `File already exists; skipped: ${item.path ?? item.id}`)
            : t(`无法读取子任务 ${item.id}：${item.code}`, `Could not read subtask ${item.id}: ${item.code}`) });
        }
        for (const item of done.failed) {
          push({ kind: 'error', text: t(`写入失败：${item.path}（${item.code}）`, `Write failed: ${item.path} (${item.code})`) });
        }
        push({ kind: 'meta', text: t(`已导出 ${done.written.length} 个文件：`, `Exported ${done.written.length} files:`) + `\n${done.written.join('\n')}` });
      })();
      return true;
    }
    if (name === 'show') {
      void (async () => {
        if (argument === '') {
          setDetail(null);
          return;
        }
        const read = await client.request('session.read', { sessionId, fullResults: true }).catch((error: unknown) => ({ code: errorCode(error) ?? 'session_read_failed' }));
        if ('code' in read) {
          push({ kind: 'error', text: t(`无法读取记录：${read.code}`, `Could not read conversation: ${read.code}`) });
          return;
        }
        const picked = findRecord(read.events, argument);
        if ('code' in picked) {
          push({ kind: 'error', text: t('请输入记录序号：/show <序号>', 'Enter an event sequence: /show <seq>') });
          return;
        }
        if (picked.record === null) {
          push({ kind: 'error', text: t(`没有序号为 ${argument} 的记录`, `Event ${argument} was not found`) });
          return;
        }
        setDetail({ seq: picked.record.seq, kind: picked.record.kind ?? 'unknown', rows: projectRecord(picked.record, locale) });
      })();
      return true;
    }
    return false;
  }, [client, locale, push, sessionId, setDetail, t]);

  return { handle };
}
