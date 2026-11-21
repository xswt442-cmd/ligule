// 资源与执行细节命令：/tool 查看一次工具调用的结果页与检查摘要，/exec 管理有限命令的执行句柄。
// 两者都只读会话记录定位目标，再向 Host 查询细节；不直接访问记录或进程。
import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type { TuiClient, TuiExecutionReference } from '../app.js';
import { parseExecCommand, parseToolCommand } from '../commands.js';
import { errorCode } from '../error-text.js';
import { executionReferenceOf } from '../execution-reference.js';
import { isRecord } from '../guards.js';
import type { TranscriptItem } from '../transcript.js';

export type ResourceCommandDeps = {
  readonly client: TuiClient;
  readonly sessionId: string;
  readonly activeSession: MutableRefObject<string>;
  readonly push: (...items: TranscriptItem[]) => void;
  readonly t: (zh: string, en: string) => string;
};

export function useResourceCommands(deps: ResourceCommandDeps): { handle: (name: string, argument: string) => boolean } {
  const { client, sessionId, activeSession, push, t } = deps;

  const handle = useCallback((name: string, argument: string): boolean => {
    if (name === 'tool') {
      const command = parseToolCommand(argument);
      if ('code' in command) {
        push({ kind: 'error', text: t(
          `命令格式不正确：${command.code}。用法：/tool <callId> [游标]`,
          `Invalid command: ${command.code}. Use /tool <callId> [cursor].`,
        ) });
        return true;
      }
      const own = sessionId;
      void (async () => {
        const history = await client.request('session.read', { sessionId: own })
          .catch((error: unknown) => ({ code: errorCode(error) ?? 'session_read_failed' }));
        if ('code' in history) {
          if (activeSession.current === own) push({ kind: 'error', text: t(`无法读取记录：${history.code}`, `Could not read conversation: ${history.code}`) });
          return;
        }
        let currentRunId: string | undefined;
        let runId: string | undefined;
        for (const event of history.events) {
          if (event.kind === 'user') {
            const acceptance = isRecord(event.run) ? event.run : undefined;
            currentRunId = typeof acceptance?.runId === 'string' ? acceptance.runId : undefined;
          }
          if (event.kind !== 'assistant' || !Array.isArray(event.toolCalls)) continue;
          if (event.toolCalls.some((call) => isRecord(call) && call.id === command.callId)) {
            runId = currentRunId;
            break;
          }
        }
        if (runId === undefined) {
          if (activeSession.current === own) push({ kind: 'error', text: t(
            `当前会话找不到工具调用 ${command.callId}。`, `Tool call ${command.callId} was not found in this Session.`,
          ) });
          return;
        }
        const resolvedRunId = runId;
        const result = await client.request('tool.result', { sessionId: own, runId: resolvedRunId, callId: command.callId,
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }), limitBytes: 4_096 })
          .catch((error: unknown) => ({ code: errorCode(error) ?? 'tool_result_failed' }));
        if (activeSession.current !== own) return;
        if (!('state' in result)) {
          push({ kind: 'error', text: result.code });
          return;
        }
        const summary = `${command.callId}: ${result.state}${result.tool === undefined ? '' : ` · ${result.tool}`}`
          + (result.eventSeq === undefined ? '' : ` · event ${result.eventSeq}`)
          + (result.code === undefined ? '' : ` · ${result.code}`);
        const output = result.output;
        const page = output?.page;
        const pageText = page === null || page === undefined ? '' : Buffer.from(page.dataBase64, 'base64').toString('utf8');
        const notes = output === undefined ? [] : [
          t(`返回 ${output.returnedValueBytes ?? '未知'} 字节；模型可见 ${output.modelVisibleBytes ?? '未知'} 字节；保存 ${output.storageStatus}${output.storedComplete === null ? '（未知是否完整）' : output.storedComplete ? '（完整）' : '（未确认完整）'}。`,
            `Returned ${output.returnedValueBytes ?? 'unknown'} bytes; ${output.modelVisibleBytes ?? 'unknown'} visible to the model; storage ${output.storageStatus}${output.storedComplete === null ? ' (completeness unknown)' : output.storedComplete ? ' (complete)' : ' (not verified complete)'}.`),
          ...(page?.nextCursor === null || page?.nextCursor === undefined ? [] : [t(`下一页游标：${page.nextCursor}`, `Next page cursor: ${page.nextCursor}`)]),
          ...(page === null ? [t('没有可验证的完整输出页。', 'No complete, verifiable output page is available.')] : []),
        ];
        const fileChanges = (result.fileChanges ?? []).map((change) => t(
          `文件变化：${change.operation} ${change.path}（${change.outcome}；基线 ${change.baselineStatus}；写后采样 ${change.observedStatus}；与基线不同 ${change.changedFromBaseline === null ? '未知' : change.changedFromBaseline ? '是' : '否'}）`,
          `File change: ${change.operation} ${change.path} (${change.outcome}; baseline ${change.baselineStatus}; after sample ${change.observedStatus}; differs from baseline ${change.changedFromBaseline === null ? 'unknown' : change.changedFromBaseline ? 'yes' : 'no'}).`,
        ));
        const checkLine = result.check === undefined ? [] : [t(
          `检查 ${result.check.declaration.name}：命令 ${result.check.commandStatus ?? result.check.status}${result.check.errorCode === undefined ? '' : `（${result.check.errorCode}）`}；报告 ${result.check.reportStatus ?? '未核实'}；范围 ${result.check.scopeStatus ?? '未核实'}；日志 ${result.check.logStatus ?? '未知'}${result.check.report === undefined ? '' : `；通过 ${result.check.report.passed}、失败 ${result.check.report.failed}、跳过 ${result.check.report.skipped}、待办 ${result.check.report.todo}`}`,
          `Check ${result.check.declaration.name}: command ${result.check.commandStatus ?? result.check.status}${result.check.errorCode === undefined ? '' : ` (${result.check.errorCode})`}; report ${result.check.reportStatus ?? 'unverified'}; scope ${result.check.scopeStatus ?? 'unverified'}; logs ${result.check.logStatus ?? 'unknown'}${result.check.report === undefined ? '' : `; passed ${result.check.report.passed}, failed ${result.check.report.failed}, skipped ${result.check.report.skipped}, todo ${result.check.report.todo}`}`,
        )];
        const checkWindow = result.check === undefined
          || (result.check.startedAt === undefined && result.check.endedAt === undefined) ? [] : [t(
          `检查时段：${result.check.startedAt ?? '开始时刻未知'} → ${result.check.endedAt ?? '结束时刻未知'}${result.check.logsRef === undefined ? '' : `；日志引用 ${result.check.logsRef.bytes} 字节`}`,
          `Check window: ${result.check.startedAt ?? 'start unknown'} → ${result.check.endedAt ?? 'end unknown'}${result.check.logsRef === undefined ? '' : `; log reference ${result.check.logsRef.bytes} bytes`}`,
        )];
        push({ kind: 'meta', text: [summary, ...notes, ...fileChanges, ...checkLine, ...checkWindow, ...(pageText === '' ? [] : [pageText])].join('\n') });
      })();
      return true;
    }
    if (name === 'exec') {
      const command = parseExecCommand(argument);
      if ('code' in command) {
        push({ kind: 'error', text: t(
          `命令格式不正确：${command.code}。用法：/exec status <executionId>；/exec wait <executionId> [毫秒]；/exec logs <executionId> [游标]；/exec cancel <executionId>`,
          `Invalid command: ${command.code}. Use /exec status <executionId>, wait <executionId> [ms], logs <executionId> [cursor], or cancel <executionId>.`,
        ) });
        return true;
      }
      const own = sessionId;
      void (async () => {
        const page = await client.request('session.read', { sessionId: own, fullResults: true })
          .catch((error: unknown) => ({ code: errorCode(error) ?? 'session_read_failed' }));
        if ('code' in page) {
          if (activeSession.current === own) push({ kind: 'error', text: t(`无法读取记录：${page.code}`, `Could not read conversation: ${page.code}`) });
          return;
        }
        const reference = page.events.map(executionReferenceOf).filter((item): item is TuiExecutionReference => item !== null)
          .findLast((item) => item.executionId === command.executionId);
        if (reference === undefined) {
          if (activeSession.current === own) push({ kind: 'error', text: t(
            `当前会话找不到命令 ${command.executionId}。`, `Execution ${command.executionId} was not found in this Session.`,
          ) });
          return;
        }
        const params = { sessionId: own, runId: reference.runId, executionId: reference.executionId };
        if (command.action === 'status') {
          const result = await client.request('execution.status', params)
            .catch((error: unknown) => ({ code: errorCode(error) ?? 'execution_status_failed' }));
          if (activeSession.current !== own) return;
          if ('code' in result) push({ kind: 'error', text: result.code });
          else push({ kind: 'meta', text: `${reference.executionId}: ${result.state}`
            + (result.exitCode === undefined ? '' : ` · exit ${result.exitCode}`)
            + (result.errorCode === undefined ? '' : ` · ${result.errorCode}`)
            + (result.terminationPending ? t(' · 进程仍未确认停止', ' · process termination unconfirmed') : '')
            + (result.cleanupPending ? t(' · 清理未完成', ' · cleanup pending') : '') });
          return;
        }
        if (command.action === 'wait') {
          const result = await client.request('execution.wait', { ...params, waitMs: command.waitMs })
            .catch((error: unknown) => ({ code: errorCode(error) ?? 'execution_wait_failed' }));
          if (activeSession.current !== own) return;
          if ('code' in result) push({ kind: 'error', text: result.code });
          else push({ kind: 'meta', text: result.waitTimedOut
            ? t(`等待结束，命令仍为 ${result.state}。`, `Wait timed out; execution remains ${result.state}.`)
            : t(`命令状态：${result.state}${result.exitCode === undefined ? '' : ` · exit ${result.exitCode}`}。`,
              `Execution state: ${result.state}${result.exitCode === undefined ? '' : ` · exit ${result.exitCode}`}.`) });
          return;
        }
        if (command.action === 'logs') {
          const result = await client.request('execution.logs', { ...params, ...(command.cursor === undefined ? {} : { cursor: command.cursor }) })
            .catch((error: unknown) => ({ code: errorCode(error) ?? 'execution_logs_failed' }));
          if (activeSession.current !== own) return;
          if ('code' in result) push({ kind: 'error', text: result.code });
          else {
            const output = result.events.map((event) => `${event.stream === 'stderr' ? '[stderr] ' : ''}${event.text}`).join('');
            const notes = [
              ...(!result.available ? [t(`日志内容暂不可用：${result.unavailableReason ?? '未知原因'}`, `Log content is unavailable: ${result.unavailableReason ?? 'unknown reason'}`)] : []),
              ...(result.gap ? [t('日志页之间有丢失内容。', 'Some log bytes were lost before this page.')] : []),
              ...(result.truncated ? [t('较早日志已超出保留范围。', 'Older logs are outside the retention window.')] : []),
              ...(result.hasMore ? [t(`下一页游标：${result.nextCursor}`, `Next cursor: ${result.nextCursor}`)] : []),
            ];
            push({ kind: 'meta', text: [output || t('当前没有新的日志。', 'No new logs are available.'), ...notes].join('\n') });
          }
          return;
        }
        const result = await client.request('execution.cancel', params)
          .catch((error: unknown) => ({ code: errorCode(error) ?? 'execution_cancel_failed' }));
        if (activeSession.current !== own) return;
        push('code' in result ? { kind: 'error', text: result.code }
          : { kind: 'meta', text: result.terminationPending || result.cleanupPending
            ? t('已请求取消，但进程停止或清理尚未确认。', 'Cancellation requested; process termination or cleanup is not yet confirmed.')
            : t(`命令状态：${result.state}。`, `Execution state: ${result.state}.`) });
      })();
      return true;
    }
    return false;
  }, [activeSession, client, push, sessionId, t]);

  return { handle };
}
