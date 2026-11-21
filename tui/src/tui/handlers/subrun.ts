// 异步子任务命令：列出、查状态、等待、补充输入与取消。
// 引用来自会话记录或已知清单；Host 负责子任务的状态与收束。
import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type { TuiClient, TuiSubrunReference, TuiSubrunStatus } from '../app.js';
import { parseSubrunCommand, type SubrunCommand } from '../commands.js';
import { errorCode } from '../error-text.js';
import { findRecord } from '../record-find.js';
import { subrunReferenceOf } from '../subrun-reference.js';
import type { TranscriptItem } from '../transcript.js';

export type SubrunCommandDeps = {
  readonly client: TuiClient;
  readonly sessionId: string;
  readonly activeSession: MutableRefObject<string>;
  readonly knownSubrunReferences: MutableRefObject<Map<string, TuiSubrunReference>>;
  readonly push: (...items: TranscriptItem[]) => void;
  readonly t: (zh: string, en: string) => string;
};

export function useSubrunCommands(deps: SubrunCommandDeps): { handle: (name: string, argument: string) => boolean } {
  const { client, sessionId, activeSession, knownSubrunReferences, push, t } = deps;

  const handle = useCallback((name: string, argument: string): boolean => {
    if (name !== 'subrun') return false;
    const command: SubrunCommand = parseSubrunCommand(argument);
    if ('code' in command) {
      push({ kind: 'error', text: t(
        `子任务命令格式不正确：${command.code}。用法：/subrun list；/subrun status <序号或 ID>；/subrun wait <序号或 ID> [毫秒]；/subrun message <序号或 ID> <文字>；/subrun cancel <序号或 ID>`,
        `Invalid subtask command: ${command.code}. Use /subrun list, status <seq or ID>, wait <seq or ID> [ms], message <seq or ID> <text>, or cancel <seq or ID>.`,
      ) });
      return true;
    }
    const own = sessionId;
    void (async () => {
      const parent = await client.request('session.read', { sessionId: own, fullResults: true })
        .catch((error: unknown) => ({ code: errorCode(error) ?? 'session_read_failed' }));
      if ('code' in parent) {
        if (activeSession.current === own) push({ kind: 'error', text: t(`无法读取记录：${parent.code}`, `Could not read conversation: ${parent.code}`) });
        return;
      }
      const references = parent.events.map(subrunReferenceOf).filter((item): item is TuiSubrunReference => item !== null);
      if (command.action === 'list') {
        const current = await client.request('status.get', { sessionId: own })
          .catch((error: unknown) => ({ code: errorCode(error) ?? 'status_read_failed' }));
        if ('code' in current) {
          if (activeSession.current === own) push({ kind: 'error', text: t(`无法读取当前运行：${current.code}`, `Could not read the current run: ${current.code}`) });
          return;
        }
        const parentRunIds: string[] = [];
        const addParentRun = (runId: unknown) => {
          if (typeof runId === 'string' && !parentRunIds.includes(runId) && parentRunIds.length < 16) parentRunIds.push(runId);
        };
        addParentRun(current.activeRunId);
        for (const event of [...parent.events].reverse()) {
          if (event.kind === 'turn') addParentRun(event.runId);
        }
        for (const reference of references) addParentRun(reference.parentRunId);
        if (parentRunIds.length === 0) {
          if (activeSession.current === own) push({ kind: 'meta', text: t('当前记录没有异步子任务。', 'This conversation has no asynchronous subtasks.') });
          return;
        }
        const pages = await Promise.all(parentRunIds.map(async parentRunId => await client.request('subrun.list', {
          sessionId: own, parentRunId, limit: 32,
        }).catch((error: unknown) => ({ code: errorCode(error) ?? 'subrun_list_failed' }))));
        if (activeSession.current !== own) return;
        const statuses = new Map<string, TuiSubrunStatus>();
        let truncated = false;
        for (const page of pages) {
          if ('code' in page) continue;
          truncated ||= page.truncated;
          for (const child of page.subruns) {
            statuses.set(child.subrunId, child);
            knownSubrunReferences.current.set(`${own}\u0000${child.subrunId}`, child);
          }
        }
        if (statuses.size === 0) {
          const firstError = pages.find(page => 'code' in page);
          if (firstError !== undefined && 'code' in firstError) {
            push({ kind: 'error', text: t(`无法列出子任务：${firstError.code}`, `Could not list subtasks: ${firstError.code}`) });
            return;
          }
          push({ kind: 'meta', text: t('当前记录没有异步子任务。', 'This conversation has no asynchronous subtasks.') });
          return;
        }
        const lines = [...statuses.values()].map(status => {
          const sequence = parent.events.find(event => subrunReferenceOf(event)?.subrunId === status.subrunId)?.seq;
          return `${status.subrunId} · ${status.state}${sequence === undefined ? '' : ` · /sub ${sequence}`}`;
        });
        if (truncated) lines.push(t('子任务列表达到扫描上限。', 'The subtask list reached its scan limit.'));
        push({ kind: 'meta', text: lines.join('\n') });
        return;
      }
      let reference: TuiSubrunReference | null = null;
      if (command.seq !== undefined) {
        const picked = findRecord(parent.events, String(command.seq));
        if ('code' in picked || picked.record === null) {
          if (activeSession.current === own) push({ kind: 'error', text: t(`没有序号为 ${command.seq} 的子任务启动记录。`, `No child start event exists at sequence ${command.seq}.`) });
          return;
        }
        reference = subrunReferenceOf(picked.record);
        if (reference === null) {
          if (activeSession.current === own) push({ kind: 'error', text: t(`记录 ${command.seq} 不是异步子任务。`, `Event ${command.seq} is not an asynchronous subtask.`) });
          return;
        }
      } else if (command.subrunId !== undefined) {
        reference = knownSubrunReferences.current.get(`${own}\u0000${command.subrunId}`) ?? null;
        if (reference === null) {
          const current = await client.request('status.get', { sessionId: own })
            .catch((error: unknown) => ({ code: errorCode(error) ?? 'status_read_failed' }));
          if (!('code' in current)) {
            const parentRunIds: string[] = [];
            const addParentRun = (runId: unknown) => {
              if (typeof runId === 'string' && !parentRunIds.includes(runId) && parentRunIds.length < 16) parentRunIds.push(runId);
            };
            addParentRun(current.activeRunId);
            for (const event of [...parent.events].reverse()) if (event.kind === 'turn') addParentRun(event.runId);
            for (const item of references) addParentRun(item.parentRunId);
            for (const parentRunId of parentRunIds) {
              const page = await client.request('subrun.list', { sessionId: own, parentRunId, limit: 32 })
                .catch((error: unknown) => ({ code: errorCode(error) ?? 'subrun_list_failed' }));
              if ('code' in page) continue;
              for (const child of page.subruns) {
                knownSubrunReferences.current.set(`${own}\u0000${child.subrunId}`, child);
              }
            }
            reference = knownSubrunReferences.current.get(`${own}\u0000${command.subrunId}`) ?? null;
          }
        }
        if (reference === null) {
          if (activeSession.current === own) push({ kind: 'error', text: t(
            `没有找到子任务 ${command.subrunId}。先运行 /subrun list 刷新子任务清单。`,
            `Subtask ${command.subrunId} was not found. Run /subrun list to refresh the list first.`,
          ) });
          return;
        }
      }
      if (reference === null) return;
      if (command.action === 'status') {
        const result = await client.request('subrun.status', {
          sessionId: own, parentRunId: reference.parentRunId, subrunId: reference.subrunId,
        }).catch((error: unknown) => ({ code: errorCode(error) ?? 'subrun_status_failed' }));
        if (activeSession.current !== own) return;
        push({ kind: 'meta', text: 'code' in result ? result.code
          : `${reference.subrunId}: ${result.state}${result.phase === null ? '' : ` · ${result.phase}`}${result.errorCode === undefined ? '' : ` · ${result.errorCode}`}` });
        return;
      }
      if (command.action === 'wait') {
        const result = await client.request('subrun.wait', {
          sessionId: own, parentRunId: reference.parentRunId, subrunIds: [reference.subrunId], timeoutMs: command.timeoutMs,
        }).catch((error: unknown) => ({ code: errorCode(error) ?? 'subrun_wait_failed' }));
        if (activeSession.current !== own) return;
        if ('code' in result) push({ kind: 'error', text: result.code });
        else {
          const state = result.subruns[0]?.state ?? 'unknown';
          push({ kind: 'meta', text: result.timedOut
            ? t(`等待结束，子任务仍为 ${state}。`, `Wait timed out; child remains ${state}.`)
            : t(`子任务状态：${state}。`, `Subtask state: ${state}.`) });
        }
        return;
      }
      if (command.action === 'message') {
        const result = await client.request('subrun.message', {
          sessionId: own, parentRunId: reference.parentRunId, subrunId: reference.subrunId,
          runId: reference.runId, input: command.input,
        }).catch((error: unknown) => ({ code: errorCode(error) ?? 'subrun_message_failed' }));
        if (activeSession.current !== own) return;
        push('code' in result ? { kind: 'error', text: t(`子任务输入未接受：${result.code}`, `Child input was not accepted: ${result.code}`) }
          : { kind: 'meta', text: t(`子任务已接受补充输入（待处理 ${result.pendingCount} 条）。`, `Child accepted the input (${result.pendingCount} pending).`) });
        return;
      }
      const result = await client.request('subrun.cancel', {
        sessionId: own, parentRunId: reference.parentRunId, subrunId: reference.subrunId, runId: reference.runId,
      }).catch((error: unknown) => ({ code: errorCode(error) ?? 'subrun_cancel_failed' }));
      if (activeSession.current !== own) return;
      push('code' in result ? { kind: 'error', text: t(`取消请求失败：${result.code}`, `Could not request cancellation: ${result.code}`) }
        : { kind: 'meta', text: result.cancelRequested
          ? t('已发出取消请求，等待子任务收束。', 'Cancellation requested; waiting for the child to settle.')
          : t(`当前子任务状态：${result.state}。`, `Child state: ${result.state}.`) });
    })();
    return true;
  }, [activeSession, client, knownSubrunReferences, push, sessionId, t]);

  return { handle };
}
