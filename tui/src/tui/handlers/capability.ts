// 会话能力命令：系统权限、屏幕截图授权与浏览器状态。
// 权限与截图由 Host 核验并持久化；外控只读会话只能观察，不能本地改变这些能力。
import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type { TuiClient, TuiStatus } from '../app.js';
import { errorCode } from '../error-text.js';
import type { TranscriptItem } from '../transcript.js';

export type CapabilityCommandDeps = {
  readonly client: TuiClient;
  readonly sessionId: string;
  readonly activeSession: MutableRefObject<string>;
  readonly externalControl: boolean;
  readonly status: TuiStatus | null;
  readonly setStatus: (next: TuiStatus | null) => void;
  readonly refreshStatus: () => Promise<void>;
  readonly openPicker: (kind: 'permission' | 'permission-network' | 'permission-confirm-full' | 'permission-confirm-network' | 'permission-confirm-partial') => void;
  readonly changePermission: (change: { readonly profile?: 'read-only' | 'workspace-write' | 'full-access'; readonly network?: 'policy' | 'unrestricted' | 'disabled' }) => Promise<void>;
  readonly push: (...items: TranscriptItem[]) => void;
  readonly t: (zh: string, en: string) => string;
};

export function useCapabilityCommands(deps: CapabilityCommandDeps): { handle: (name: string, argument: string) => boolean } {
  const { client, sessionId, activeSession, externalControl, status, setStatus, refreshStatus, openPicker, changePermission, push, t } = deps;

  const handle = useCallback((name: string, argument: string): boolean => {
    if (name === 'screen') {
      if (externalControl) {
        push({ kind: 'meta', text: t('外控会话的截图能力由独立 Grant 控制，请在外控授权中管理。', 'Screen capture for an externally controlled Session is managed by its separate grant.') });
        return true;
      }
      const parts = argument.trim().split(/\s+/u).filter(Boolean);
      if (parts.length === 0) {
        const owner = sessionId;
        void client.request('status.get', { sessionId: owner }).then(current => {
          if (activeSession.current !== owner) return;
          setStatus(current);
          push({ kind: 'meta', text: current.screenCapture?.enabled === true
            ? t('本会话截图已授权；/screen off 可立即撤销。', 'Screen capture is allowed for this Session; /screen off revokes it.')
            : t('本会话截图关闭。/screen on 查看授权说明。', 'Screen capture is disabled; /screen on shows the consent details.') });
        }, error => push({ kind: 'error', text: errorCode(error) ?? 'screen_capture_status_failed' }));
        return true;
      }
      if (parts.length === 1 && parts[0] === 'on') {
        push({ kind: 'meta', text: t('截图会读取现有画面，可能包含其他应用或私人信息，并发送给当前图像模型。允许本会话及内部子任务截图，请输入 /screen on confirm；可用 /screen off 撤销。截图不会切换焦点或提供鼠标键盘控制。', 'Captures read the existing screen, may include other applications or private information, and are sent to the selected image model. Enter /screen on confirm to permit this Session and its children; /screen off revokes consent. Capture does not change focus or provide mouse and keyboard control.') });
        return true;
      }
      const enabling = parts.length === 2 && parts[0] === 'on' && parts[1] === 'confirm';
      if (!enabling && !(parts.length === 1 && parts[0] === 'off')) {
        push({ kind: 'error', text: t('用法：/screen [on [confirm]|off]', 'Usage: /screen [on [confirm]|off]') });
        return true;
      }
      const owner = sessionId;
      void (async () => {
        try {
          await client.request('screen-capture.set', { sessionId: owner, enabled: enabling, ...(enabling ? { confirmScreenCapture: true } : {}) });
          if (activeSession.current !== owner) return;
          await refreshStatus();
          push({ kind: 'meta', text: enabling ? t('本会话截图已授权', 'Screen capture allowed for this Session') : t('本会话截图授权已撤销', 'Screen capture consent revoked') });
        } catch (error) {
          if (activeSession.current === owner) push({ kind: 'error', text: errorCode(error) ?? 'screen_capture_update_failed' });
        }
      })();
      return true;
    }
    if (name === 'browser') {
      const action = argument.trim();
      if (action !== '' && action !== 'stop' && action !== 'resume') {
        push({ kind: 'error', text: t('用法：/browser [stop|resume]', 'Usage: /browser [stop|resume]') });
        return true;
      }
      const owner = sessionId;
      void (async () => {
        const current = await client.request('status.get', { sessionId: owner }).catch((error: unknown) => ({ code: errorCode(error) ?? 'status_read_failed' }));
        if (!('policy' in current)) {
          if (activeSession.current === owner) push({ kind: 'error', text: current.code });
          return;
        }
        const state = current.browser;
        if (state === undefined) {
          if (activeSession.current === owner) push({ kind: 'error', text: 'browser_status_unavailable' });
          return;
        }
        setStatus(current);
        const describe = (browser: NonNullable<TuiStatus['browser']>) => t(
          `浏览器：配置 ${browser.configured ? '已配置' : '未配置'} · 服务 ${browser.available ? '可用' : `不可用（${browser.code ?? 'browser_unavailable'}）`} · 权限 ${browser.permitted ? '允许' : `禁止（${browser.code ?? 'browser_permission_denied'}）`} · 暂停 ${browser.paused ? '是' : '否'} · MCP 连接 ${browser.connected ? '已连接' : '未连接'}`,
          `Browser: configured ${browser.configured ? 'yes' : 'no'} · service ${browser.available ? 'available' : `unavailable (${browser.code ?? 'browser_unavailable'})`} · permitted ${browser.permitted ? 'yes' : `no (${browser.code ?? 'browser_permission_denied'})`} · paused ${browser.paused ? 'yes' : 'no'} · MCP connection ${browser.connected ? 'connected' : 'disconnected'}`,
        );
        if (action === '') {
          if (activeSession.current === owner) push({ kind: state.available && state.permitted ? 'meta' : 'error', text: describe(state) });
          return;
        }
        if (externalControl) {
          if (activeSession.current === owner) push({ kind: 'error', text: t('外控只读会话不能本地改变浏览器；请先使用 /takeover 接管，或关闭外控会话。', 'An externally controlled read-only Session cannot change its browser locally; use /takeover first or close the external session.') });
          return;
        }
        if (!state.changeAllowed) {
          if (activeSession.current === owner) push({ kind: 'error', text: t('此连接不能修改浏览器状态；请先接管会话或关闭外控会话。', 'This connection cannot change browser state; take over the Session or close the external session first.') });
          return;
        }
        if (!state.available || !state.permitted) {
          if (activeSession.current === owner) push({ kind: 'error', text: describe(state) });
          return;
        }
        const method = action === 'stop' ? 'browser.stop' : 'browser.resume';
        const changed = await client.request(method, { sessionId: owner }).catch((error: unknown) => ({ code: errorCode(error) ?? (action === 'stop' ? 'browser_stop_failed' : 'browser_resume_failed') }));
        if (!('browser' in changed)) {
          if (activeSession.current === owner) push({ kind: 'error', text: changed.code });
          return;
        }
        if (activeSession.current !== owner) return;
        setStatus({ ...current, browser: changed.browser });
        push({ kind: 'meta', text: describe(changed.browser) });
      })();
      return true;
    }
    if (name === 'permission') {
      const [target, value, ...extra] = argument.trim().split(/\s+/).filter((part) => part !== '');
      if (target === undefined) { openPicker('permission'); return true; }
      if (extra.length > 0) {
        push({ kind: 'error', text: t('用法：/permission [read-only|workspace-write|full-access|network [policy|disabled|unrestricted]]', 'Usage: /permission [read-only|workspace-write|full-access|network [policy|disabled|unrestricted]]') });
        return true;
      }
      if (target === 'network') {
        if (value === undefined) { openPicker('permission-network'); return true; }
        if (value !== 'policy' && value !== 'disabled' && value !== 'unrestricted') {
          push({ kind: 'error', text: t('网络选项须为 policy、disabled 或 unrestricted。', 'Network must be policy, disabled, or unrestricted.') });
        } else if (value === 'unrestricted') {
          openPicker('permission-confirm-network');
        } else {
          void changePermission({ network: value });
        }
        return true;
      }
      if (target !== 'read-only' && target !== 'workspace-write' && target !== 'full-access') {
        push({ kind: 'error', text: t('用法：/permission [read-only|workspace-write|full-access|network [policy|disabled|unrestricted]]', 'Usage: /permission [read-only|workspace-write|full-access|network [policy|disabled|unrestricted]]') });
        return true;
      }
      if (target === 'full-access') {
        if (status?.permission?.profile === 'full-access') void changePermission({ profile: target });
        else openPicker('permission-confirm-full');
      } else if (target === 'workspace-write' && status?.permission !== undefined
        && (!status.permission.workspaceTrusted || status.permission.partialWorkspaceWriteConfirmationRequired
          && !status.permission.partialWorkspaceWriteConfirmed)) {
        openPicker('permission-confirm-partial');
      } else {
        void changePermission({ profile: target });
      }
      return true;
    }
    return false;
  }, [activeSession, changePermission, client, externalControl, openPicker, push, refreshStatus, sessionId, setStatus, status, t]);

  return { handle };
}
