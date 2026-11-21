// 外控授权面板：列出、复制本地 MCP 配置、撤销，以及创建向导的入口。
// 授权内容与版本由 Host 持有；TUI 只在确认后提交，不保存第二份授权状态。
import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type { TuiClient } from '../app.js';
import { agentMcpConfig } from '../agent-mcp.js';
import { copyToClipboard } from '../clipboard.js';
import { parseControlCommand, usageText } from '../commands.js';
import type { ControlWizard } from '../control-wizard.js';
import { errorCode } from '../error-text.js';
import type { AgentControlSnapshot, AgentGrant } from '../app.js';
import type { TranscriptItem } from '../transcript.js';

export type ControlCommandDeps = {
  readonly client: TuiClient;
  readonly projectRoot: string | undefined;
  readonly activeSession: MutableRefObject<string>;
  readonly controlWizardGeneration: MutableRefObject<number>;
  readonly controlWizardSubmittingRef: MutableRefObject<boolean>;
  readonly setControlWizardSubmitting: (next: boolean) => void;
  readonly showControlWizard: (next: ControlWizard | null) => void;
  readonly setPanel: (next: null) => void;
  readonly setControlSnapshot: (next: AgentControlSnapshot) => void;
  readonly setControlTarget: (next: string) => void;
  readonly openPicker: (kind: 'control' | 'control-revoke-confirm') => void;
  readonly push: (...items: TranscriptItem[]) => void;
  readonly t: (zh: string, en: string) => string;
};

export function useControlCommands(deps: ControlCommandDeps): { handle: (name: string, argument: string) => boolean } {
  const {
    client, projectRoot, activeSession, controlWizardGeneration, controlWizardSubmittingRef,
    setControlWizardSubmitting, showControlWizard, setPanel, setControlSnapshot, setControlTarget, openPicker, push, t,
  } = deps;

  const handle = useCallback((name: string, argument: string): boolean => {
    if (name !== 'control') return false;
    const command = parseControlCommand(argument);
    if ('code' in command) {
      const [zh, en] = usageText(command.code);
      push({ kind: 'error', text: t(zh, en) });
      return true;
    }
    if (command.action === 'picker') {
      openPicker('control');
      return true;
    }
    if (command.action === 'create') {
      if (projectRoot === undefined || projectRoot === '') {
        push({ kind: 'error', text: t('当前没有已选择的项目目录。', 'No project directory is selected.') });
        return true;
      }
      const owner = activeSession.current;
      const generation = ++controlWizardGeneration.current;
      controlWizardSubmittingRef.current = false;
      setControlWizardSubmitting(false);
      void (async () => {
        try {
          const trust = await client.request('mcp.trust.list', { projectRoot });
          if (generation !== controlWizardGeneration.current || activeSession.current !== owner) return;
          const mcpServers = trust.servers.filter((server) =>
            server.trustScopes.project?.trusted === true || server.trustScopes.user?.trusted === true,
          ).map((server) => server.name);
          showControlWizard({ step: 0, values: {}, mcpServers, mcpTools: [] });
          setPanel(null);
          push({ kind: 'meta', text: t(
            `开始创建授权；每一步按 Enter 确认，输入 cancel 可取消。已信任的 MCP Server：${mcpServers.join(', ') || '无'}`,
            `Grant setup started. Press Enter after each answer; type cancel to stop. Trusted MCP servers: ${mcpServers.join(', ') || 'none'}`,
          ) });
        } catch (error) {
          if (generation !== controlWizardGeneration.current || activeSession.current !== owner) return;
          push({ kind: 'error', text: t(`无法读取 MCP Server 信任状态：${errorCode(error) ?? 'mcp_trust_list_failed'}`, `Could not read MCP server trust: ${errorCode(error) ?? 'mcp_trust_list_failed'}`) });
        }
      })();
      return true;
    }
    const wanted = command.action === 'copy' || command.action === 'revoke' ? command.id : '';
    void (async () => {
      try {
        const snapshot = await client.request('agent-control.list', {}) as AgentControlSnapshot;
        setControlSnapshot(snapshot);
        if (command.action === 'list') {
          const lines = snapshot.grants.length === 0 ? [t('尚未创建外控授权。', 'No external Agent grants have been created.')]
            : snapshot.grants.map((grant: AgentGrant) => {
              const state = grant.revokedAt !== null ? t('已撤销', 'revoked')
                : grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.now() ? t('已到期', 'expired') : t('可用', 'available');
              const expiry = grant.expiresAt === null ? t('无到期时间', 'no expiry') : `${t('到期', 'expires')} ${new Date(grant.expiresAt).toLocaleString()}`;
              const source = grant.source === 'trusted-ui'
                ? t('可信界面创建', 'Trusted UI')
                : t('历史记录未保存来源', 'Legacy record; source not recorded');
              return `${grant.id} · ${grant.name} · ${state} · ${t('权限', 'permission')} ${grant.defaultPermissionProfile} / ${grant.maxPermissionProfile} · ${t('网络', 'network')} ${grant.defaultNetwork} / ${grant.maxNetwork} · Policy ${grant.defaultPolicy} (${grant.allowedPolicies.join(', ')}) · MCP ${grant.allowedMcpServers.join(', ') || t('无', 'none')} · ${t('工具', 'tools')} ${grant.allowedMcpTools.join(', ') || t('无', 'none')} · ${expiry} · ${t('来源', 'source')} ${source} · ${grant.projectRoot} · ${t('在线状态未知', 'online status unknown')}`;
            });
          const invalid = snapshot.grants.filter((grant) => grant.revokedAt !== null
            || (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.now())).length;
          push({ kind: 'meta', text: invalid === 0 ? lines.join('\n') : [
            lines.join('\n'),
            t(`其中 ${invalid} 张已失效（撤销/到期）：不能建立新的外控连接；已建立的会话按原记录继续，需要时请重新创建授权。`,
              `${invalid} grant(s) are no longer valid (revoked/expired): they cannot open new external control connections; open sessions continue from their record. Create a new grant when needed.`),
          ].join('\n') });
          return;
        }
        const matches = snapshot.grants.filter((grant) => grant.id === wanted || grant.id.startsWith(wanted));
        if (matches.length !== 1) {
          push({ kind: 'error', text: matches.length === 0
            ? t(`未找到授权 ${wanted}`, `Grant ${wanted} was not found`)
            : t(`授权编号 ${wanted} 不唯一，请输入更多字符`, `Grant ID ${wanted} is ambiguous; enter more characters`) });
          return;
        }
        const grant = matches[0]!;
        if (command.action === 'copy') {
          const copied = await copyToClipboard(agentMcpConfig(grant));
          push('program' in copied
            ? { kind: 'meta', text: t(`已复制授权 ${grant.id} 的本地 MCP 配置`, `Copied local MCP configuration for grant ${grant.id}`) }
            : { kind: 'error', text: t(`复制配置失败：${copied.code}`, `Could not copy configuration: ${copied.code}`) });
          return;
        }
        if (grant.revokedAt !== null || (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.now())) {
          push({ kind: 'error', text: t('此授权已撤销或到期，不能再次撤销。', 'This grant is revoked or expired and cannot be revoked again.') });
          return;
        }
        setControlTarget(grant.id);
        openPicker('control-revoke-confirm');
      } catch (error) {
        push({ kind: 'error', text: t(`外控授权操作失败：${errorCode(error) ?? 'agent_control_failed'}`, `Agent Control operation failed: ${errorCode(error) ?? 'agent_control_failed'}`) });
      }
    })();
    return true;
  }, [activeSession, client, controlWizardGeneration, controlWizardSubmittingRef, openPicker, projectRoot, push, setControlSnapshot, setControlTarget, setControlWizardSubmitting, setPanel, showControlWizard, t]);

  return { handle };
}
