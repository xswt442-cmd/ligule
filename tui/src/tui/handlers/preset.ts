// 任务预设命令：列出、预览与在当前活动父任务下启动预设子任务。
// 预设目录与执行都由 Host 负责；TUI 只显示结果，并登记新的子任务引用供后续查看。
import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type { TuiClient, TuiSubrunReference } from '../app.js';
import { parsePresetCommand, type PresetCommand } from '../commands.js';
import { errorCode } from '../error-text.js';
import type { TranscriptItem } from '../transcript.js';

export type PresetCommandDeps = {
  readonly client: TuiClient;
  readonly sessionId: string;
  readonly activeSession: MutableRefObject<string>;
  readonly knownSubrunReferences: MutableRefObject<Map<string, TuiSubrunReference>>;
  readonly push: (...items: TranscriptItem[]) => void;
  readonly t: (zh: string, en: string) => string;
};

export function usePresetCommands(deps: PresetCommandDeps): { handle: (name: string, argument: string) => boolean } {
  const { client, sessionId, activeSession, knownSubrunReferences, push, t } = deps;

  const handle = useCallback((name: string, argument: string): boolean => {
    if (name !== 'preset') return false;
    const command: PresetCommand = parsePresetCommand(argument);
    if ('code' in command) {
      push({ kind: 'error', text: t(
        `预设命令格式不正确：${command.code}。用法：/preset list；/preset preview <id>；/preset start <id> <任务>`,
        `Invalid preset command: ${command.code}. Use /preset list, preview <id>, or start <id> <task>.`,
      ) });
      return true;
    }
    const own = sessionId;
    void (async () => {
      if (command.action === 'list') {
        const result = await client.request('preset.list', { sessionId: own, limit: 64 })
          .catch((error: unknown) => ({ code: errorCode(error) ?? 'preset_list_failed' }));
        if (activeSession.current !== own) return;
        if ('code' in result) {
          push({ kind: 'error', text: t(`无法列出任务预设：${result.code}`, `Could not list task presets: ${result.code}`) });
          return;
        }
        if (result.presets.length === 0) {
          push({ kind: 'meta', text: t('当前没有可用任务预设。', 'No task presets are available.') });
          return;
        }
        const lines = result.presets.map(preset => preset.errorCode === undefined
          ? `${preset.id} · ${preset.layer} · ${preset.description ?? ''}`
          : `${preset.id} · ${preset.layer} · ${t(`无效：${preset.errorCode}`, `invalid: ${preset.errorCode}`)}`);
        if (result.truncated) lines.push(t('列表有更多内容或达到扫描上限。', 'More entries exist or the scan limit was reached.'));
        push({ kind: 'meta', text: lines.join('\n') });
        return;
      }
      if (command.action === 'preview') {
        const current = await client.request('status.get', { sessionId: own })
          .catch((error: unknown) => ({ code: errorCode(error) ?? 'status_read_failed' }));
        if ('code' in current) {
          if (activeSession.current === own) push({ kind: 'error', text: t(`无法读取当前运行：${current.code}`, `Could not read the current run: ${current.code}`) });
          return;
        }
        const result = await client.request('preset.preview', {
          sessionId: own, presetId: command.presetId,
          ...(typeof current.activeRunId === 'string' ? { parentRunId: current.activeRunId } : {}),
        }).catch((error: unknown) => ({ code: errorCode(error) ?? 'preset_preview_failed' }));
        if (activeSession.current !== own) return;
        if ('code' in result) {
          push({ kind: 'error', text: t(`无法预览预设：${result.code}`, `Could not preview preset: ${result.code}`) });
          return;
        }
        const modeTools = result.mode.tools === '*' ? '*' : result.mode.tools.join(', ');
        const modePrompt = result.mode.prompt === '*' ? '*' : result.mode.prompt.join(', ');
        push({ kind: 'meta', text: [
          `${result.presetId} · ${result.layer} · ${result.executable ? t('可在当前运行中启动', 'executable under the current run') : t('仅预览，需活动父任务才能启动', 'preview only; an active parent run is required')}`,
          result.description,
          t(`模式：${result.mode.name}；工具：${modeTools || '无'}；片段：${modePrompt || '无'}`, `Mode: ${result.mode.name}; tools: ${modeTools || 'none'}; prompt fragments: ${modePrompt || 'none'}`),
          t(`权限上限：${result.permission.profile}；网络：${result.permission.network}`, `Permission ceiling: ${result.permission.profile}; network: ${result.permission.network}`),
          t(`生成：${result.generation.outputTokens ?? '继承'} Token；思考：${result.generation.thinkingEffort ?? '继承'}`, `Generation: ${result.generation.outputTokens ?? 'inherited'} tokens; thinking: ${result.generation.thinkingEffort ?? 'inherited'}`),
          t(`循环上限：${result.limits.loopIterations}；模型调用上限：${result.limits.modelCalls}`, `Loop limit: ${result.limits.loopIterations}; model-call limit: ${result.limits.modelCalls}`),
          result.requiredChecks.length === 0 ? t('完成检查：无额外门槛', 'Completion checks: no additional gate')
            : t(`完成检查：${result.requiredChecks.join(', ')}`, `Completion checks: ${result.requiredChecks.join(', ')}`),
          result.narrowedFields.length === 0 ? '' : t(`被父运行收窄：${result.narrowedFields.join(', ')}`, `Narrowed by the parent run: ${result.narrowedFields.join(', ')}`),
          result.instruction,
        ].filter(line => line !== '').join('\n') });
        return;
      }
      const current = await client.request('status.get', { sessionId: own })
        .catch((error: unknown) => ({ code: errorCode(error) ?? 'status_read_failed' }));
      if (activeSession.current !== own) return;
      if ('code' in current || typeof current.activeRunId !== 'string') {
        push({ kind: 'error', text: t('启动预设子任务需要一个当前活动的父任务。', 'Starting a preset child requires an active parent run.') });
        return;
      }
      const result = await client.request('subrun.start', {
        sessionId: own, parentRunId: current.activeRunId, task: command.task, presetId: command.presetId,
      }).catch((error: unknown) => ({ code: errorCode(error) ?? 'preset_start_failed' }));
      if (activeSession.current !== own) return;
      if ('code' in result) {
        push({ kind: 'error', text: t(`无法启动预设子任务：${result.code}`, `Could not start preset child: ${result.code}`) });
        return;
      }
      knownSubrunReferences.current.set(`${own}\u0000${result.subrunId}`, result);
      push({ kind: 'meta', text: t(
        `已启动 ${command.presetId}：子任务 ${result.subrunId} · Session ${result.sessionId} · Run ${result.runId}`,
        `Started ${command.presetId}: child ${result.subrunId} · Session ${result.sessionId} · Run ${result.runId}`,
      ) });
    })().catch((error: unknown) => {
      if (activeSession.current === own) push({ kind: 'error', text: t(`预设操作失败：${errorCode(error) ?? 'preset_operation_failed'}`, `Preset operation failed: ${errorCode(error) ?? 'preset_operation_failed'}`) });
    });
    return true;
  }, [activeSession, client, knownSubrunReferences, push, sessionId, t]);

  return { handle };
}
