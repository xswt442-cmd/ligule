// 配置与权限类命令：凭据状态、模型选择、思考强度、工具模式、审批方式。
// 这些命令共享“读当前状态、调用 Host、刷新界面状态”的路径，由 App 传入。
import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type { Locale } from '@ligule/core/tui.js';
import type { TuiClient, TuiStatus } from '../app.js';
import { errorCode, errorMessage } from '../error-text.js';
import { runtimeFailureText } from '../errors.js';
import type { TranscriptItem } from '../transcript.js';

export type ConfigCommandDeps = {
  readonly client: TuiClient;
  readonly sessionId: string;
  readonly activeSession: MutableRefObject<string>;
  readonly projectRoot: string | undefined;
  readonly push: (...items: TranscriptItem[]) => void;
  readonly t: (zh: string, en: string) => string;
  readonly locale: Locale;
  readonly openPicker: (kind: 'model' | 'thinking' | 'mode' | 'policy' | 'policy-confirm-never') => void;
  readonly refreshStatus: () => Promise<void>;
  readonly changeThinking: (effort: string) => void;
  readonly setStatus: (next: TuiStatus | null) => void;
};

export function useConfigCommands(deps: ConfigCommandDeps): { handle: (name: string, argument: string) => boolean } {
  const { client, sessionId, activeSession, projectRoot, push, t, locale, openPicker, refreshStatus, changeThinking, setStatus } = deps;

  const handle = useCallback((name: string, argument: string): boolean => {
    if (name === 'credentials') {
      void (async () => {
        try {
          const [current, config] = await Promise.all([
            client.request('status.get', { sessionId }),
            client.request('config.get', { projectRoot }),
          ]);
          const service = config.services.find(item => item.id === current.serviceId);
          const reference = service?.apiKeyEnv ?? config.model?.apiKeyEnv ?? 'LIGULE_API_KEY';
          const credential = await client.request('credentials.status', { reference });
          const source = credential.source === 'environment' ? t('环境变量', 'environment') : credential.source === 'keyring' ? t('系统凭据', 'OS credential store') : t('未设置', 'not set');
          push({ kind: credential.configured ? 'meta' : 'error', text: [
            `${t('模型', 'Model')}: ${current.selectedModel ?? current.model ?? t('未选择', 'not selected')}`,
            `${t('凭据引用', 'Credential reference')}: ${reference} · ${source}`,
            ...(credential.configured ? [] : [runtimeFailureText('provider_credential_missing', locale) ?? 'provider_credential_missing']),
          ].join('\n') });
        } catch (error) {
          const code = errorCode(error) ?? 'credential_status_failed';
          push({ kind: 'error', text: `${code}\n${runtimeFailureText(code, locale) ?? t('无法检查凭据状态', 'Could not check credential status')}` });
        }
      })();
      return true;
    }
    if (name === 'model') {
      if (argument.trim() === '') { openPicker('model'); return true; }
      void (async () => {
        try {
          const [provider, model, ...extra] = argument.trim().split(/\s+/);
          if (model === undefined || extra.length > 0) {
            push({ kind: 'error', text: t('用法：/model <服务> <模型>', 'Usage: /model <service> <model>') });
            return;
          }
          const changed = await client.request('model.select', { sessionId, provider, model });
          await refreshStatus();
          push({ kind: 'meta', text: changed.when === 'round'
            ? t(`下轮使用 ${changed.model}`, `${changed.model} will apply next turn`)
            : t(`已切换至 ${changed.model}`, `Switched to ${changed.model}`) });
        } catch (error) {
          push({ kind: 'error', text: t(`无法选择模型：${errorCode(error) ?? errorMessage(error) ?? 'unknown'}`, `Could not select model: ${errorCode(error) ?? errorMessage(error) ?? 'unknown'}`) });
        }
      })();
      return true;
    }
    if (name === 'think') {
      const asked = argument.trim();
      if (asked === '') { openPicker('thinking'); return true; }
      if (!['default', 'none', 'low', 'high', 'max'].includes(asked)) {
        push({ kind: 'error', text: t('用法：/think [none|low|high|max|default]', 'Usage: /think [none|low|high|max|default]') });
        return true;
      }
      changeThinking(asked);
      return true;
    }
    if (name === 'mode') {
      if (argument === '') { openPicker('mode'); return true; }
      void (async () => {
        const own = sessionId;
        const switched = await client.request('mode.set', { sessionId: own, name: argument }).catch((error: unknown) => ({ code: errorCode(error) ?? 'mode_switch_failed' }));
        if (activeSession.current !== own) return;
        if ('code' in switched) {
          push({ kind: 'error', text: t(`无法切换工具模式：${switched.code}`, `Could not change tool mode: ${switched.code}`) });
          return;
        }
        setStatus(await client.request('status.get', { sessionId: own }).catch(() => null));
        if (activeSession.current !== own) return;
        push({ kind: 'meta', text: switched.pending === null
          ? t(`工具模式：${switched.mode}（${switched.tools.length} 个工具）`, `Tool mode: ${switched.mode} (${switched.tools.length} tools)`)
          : t(`${switched.pending} 将于下轮生效`, `${switched.pending} will apply next turn`) });
      })();
      return true;
    }
    if (name === 'policy') {
      if (argument === '') { openPicker('policy'); return true; }
      void (async () => {
        const asked = argument === 'reset' ? 'default' : argument === 'none' ? 'ask' : argument;
        if (asked !== 'default' && asked !== 'always' && asked !== 'ask' && asked !== 'auto' && asked !== 'never') {
          push({ kind: 'error', text: t('用法：/policy always|ask|auto|never|reset（旧 none 等同 ask）', 'Usage: /policy always|ask|auto|never|reset (legacy none equals ask)') });
          return;
        }
        // 命令行不能绕过二次确认：选择“完全不审批”与选择器走同一条确认路径。
        if (asked === 'never') { openPicker('policy-confirm-never'); return; }
        const own = sessionId;
        const changed = await client.request('policy.set', { sessionId: own, mode: asked }).catch((error: unknown) => ({ code: errorCode(error) ?? 'policy_change_failed' }));
        if (activeSession.current !== own) return;
        if ('code' in changed) {
          push({ kind: 'error', text: t(`无法修改审批方式：${changed.code}`, `Could not change approval mode: ${changed.code}`) });
          return;
        }
        setStatus(await client.request('status.get', { sessionId: own }).catch(() => null));
        if (activeSession.current !== own) return;
        push({ kind: 'meta', text: changed.policySource === 'session'
          ? t(`当前会话审批方式：${changed.policy}（已生效）`, `Session approval mode: ${changed.policy} (active now)`)
          : t(`已恢复默认审批方式：${changed.policy}`, `Default approval mode restored: ${changed.policy}`) });
      })();
      return true;
    }
    return false;
  }, [activeSession, changeThinking, client, locale, openPicker, projectRoot, push, refreshStatus, sessionId, setStatus, t]);

  return { handle };
}
