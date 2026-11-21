// 外部集成命令：MCP Server 的增删/信任/工具清单、用户扩展开关、工作区信任撤销。
// 这些命令只依赖 Host 连接、当前会话、通知出口与信任存储；MCP 信任待确认状态由本模块独占。
import { useCallback, useEffect, useState } from 'react';
import type { TuiClient } from '../app.js';
import { parseExtensionsCommand, parseMcpCommand, usageText, type McpTrustScope } from '../commands.js';
import { errorCode, errorMessage } from '../error-text.js';
import type { TranscriptItem } from '../transcript.js';

type McpTrustPending = {
  readonly server: string;
  readonly scope: McpTrustScope;
  readonly version: string;
  readonly identityDigest: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
};

export type IntegrationCommandDeps = {
  readonly client: TuiClient;
  readonly projectRoot: string | undefined;
  readonly sessionId: string;
  readonly activeSession: { readonly current: string };
  readonly sessionIdentityGeneration: { readonly current: number };
  readonly alive: { readonly current: boolean };
  readonly push: (...items: TranscriptItem[]) => void;
  readonly t: (zh: string, en: string) => string;
  readonly trust: { revoke(): Promise<unknown> } | undefined;
  readonly exitTui: (code: string) => void;
  readonly reportMcpTrustOutcome: (owner: string, outcome: TranscriptItem) => void;
};

export function useIntegrationCommands(deps: IntegrationCommandDeps): { handle: (name: string, argument: string) => boolean } {
  const { client, projectRoot, sessionId, activeSession, sessionIdentityGeneration, alive, push, t, trust, exitTui, reportMcpTrustOutcome } = deps;
  const [pending, setPending] = useState<McpTrustPending | null>(null);
  useEffect(() => { setPending(null); }, [sessionId]);

  const handle = useCallback((name: string, argument: string): boolean => {
    if (name === 'mcp') {
      const command = parseMcpCommand(argument);
      if ('code' in command) {
        const [zh, en] = usageText(command.code);
        push({ kind: 'error', text: t(zh, en) });
        return true;
      }
      if (command.action === 'add') {
        void (async () => {
          try {
            const config = await client.request('config.get', { projectRoot });
            const version = (config.layers ?? []).find((layer) => layer.layer === 'user')?.version ?? '';
            await client.request('config.set', {
              projectRoot, field: 'mcp.servers', layer: 'user', version, op: 'set',
              serverName: command.name, serverCommand: command.executable,
              ...(command.args.length === 0 ? {} : { serverArgs: [...command.args] }),
            });
            push({ kind: 'meta', text: t(
              `${command.name} 已保存到使用者默认配置。环境变量与工作目录请在配置文件中补充；新配置需重新信任（/mcp trust）。`,
              `${command.name} was saved to the user defaults. Add environment references and a working directory in the config file; the new configuration needs trust again (/mcp trust).`,
            ) });
          } catch (error) {
            push({ kind: 'error', text: t(`MCP Server 未保存：${errorCode(error) ?? errorMessage(error) ?? 'config_set_failed'}`, `MCP server was not saved: ${errorCode(error) ?? errorMessage(error) ?? 'config_set_failed'}`) });
          }
        })();
        return true;
      }
      if (command.action === 'remove') {
        void (async () => {
          try {
            const config = await client.request('config.get', { projectRoot });
            const version = (config.layers ?? []).find((layer) => layer.layer === 'user')?.version ?? '';
            await client.request('config.set', {
              projectRoot, field: 'mcp.servers', layer: 'user', version, op: 'remove', serverName: command.name,
            });
            push({ kind: 'meta', text: t(`已从使用者默认配置移除 ${command.name}；信任记录与其他配置层不受影响。`, `${command.name} was removed from the user defaults; trust records and other layers are untouched.`) });
          } catch (error) {
            push({ kind: 'error', text: t(`MCP Server 未移除：${errorCode(error) ?? errorMessage(error) ?? 'config_set_failed'}`, `MCP server was not removed: ${errorCode(error) ?? errorMessage(error) ?? 'config_set_failed'}`) });
          }
        })();
        return true;
      }
      if (command.action === 'confirm') {
        if (pending === null || pending.sessionId !== sessionId || pending.sessionGeneration !== sessionIdentityGeneration.current
          || activeSession.current !== sessionId) {
          if (pending !== null) setPending((current) => current === pending ? null : current);
          push({ kind: 'error', text: t('没有待确认的 MCP Server 信任请求。', 'No MCP server trust request is pending.') });
          return true;
        }
        const isCurrent = () => alive.current && activeSession.current === pending.sessionId
          && sessionId === pending.sessionId && sessionIdentityGeneration.current === pending.sessionGeneration;
        void (async () => {
          let trustWriteStarted = false;
          try {
            const snapshot = await client.request('mcp.trust.list', { projectRoot, sessionId: pending.sessionId });
            if (!isCurrent()) return;
            const current = snapshot.servers.find((server) => server.name === pending.server);
            if (current === undefined || current.identityDigest !== pending.identityDigest) {
              setPending((value) => value === pending ? null : value);
              throw new Error('mcp_server_config_changed');
            }
            trustWriteStarted = true;
            await client.request('mcp.trust.set', {
              projectRoot, sessionId: pending.sessionId, server: pending.server, identityDigest: pending.identityDigest, scope: pending.scope, trusted: true,
              confirmTrust: true, confirmExternalAccess: true,
              ...(pending.scope === 'session' ? {} : { version: snapshot.version }),
            });
            setPending((value) => value === pending ? null : value);
            reportMcpTrustOutcome(pending.sessionId, {
              kind: 'meta', text: t(`已在${pending.scope}范围信任 ${pending.server}。`, `${pending.server} is trusted at ${pending.scope} scope.`),
            });
          } catch (error) {
            if (!alive.current || (!trustWriteStarted && !isCurrent())) return;
            setPending((value) => value === pending ? null : value);
            reportMcpTrustOutcome(pending.sessionId, {
              kind: 'error', text: t(`MCP Server 未获信任：${errorCode(error) ?? errorMessage(error) ?? 'mcp_trust_failed'}`, `MCP server was not trusted: ${errorCode(error) ?? errorMessage(error) ?? 'mcp_trust_failed'}`),
            });
          }
        })();
        return true;
      }
      if (command.action === 'list') {
        void client.request('mcp.trust.list', { projectRoot, sessionId }).then((snapshot) => {
          const lines = snapshot.servers.length === 0 ? [t('当前项目没有配置 MCP Server。', 'No MCP servers are configured for this project.')]
            : snapshot.servers.map((server) => `${server.name} · ${server.trust === null ? t('未信任', 'untrusted') : server.trust.trusted ? t(`已信任 ${server.trust.scope}（可信本机界面）`, `trusted ${server.trust.scope} (trusted local UI)`) : t(`已阻止 ${server.trust.scope}`, `blocked ${server.trust.scope}`)} · ${server.command} ${server.args.join(' ')} · cwd ${server.cwd}`);
          push({ kind: 'meta', text: lines.join('\n') });
        }, (error: unknown) => push({ kind: 'error', text: t(`无法读取 MCP Server：${errorCode(error) ?? 'mcp_trust_list_failed'}`, `Could not read MCP servers: ${errorCode(error) ?? 'mcp_trust_list_failed'}`) }));
        return true;
      }
      if (command.action === 'trust') {
        const scope = command.scope;
        if (scope === 'session' && sessionId === '') {
          push({ kind: 'error', text: t('当前没有会话，不能保存会话范围的信任。', 'There is no active session for session-scoped trust.') });
          return true;
        }
        const owner = sessionId;
        const generation = sessionIdentityGeneration.current;
        const isCurrent = () => alive.current && activeSession.current === owner
          && sessionId === owner && sessionIdentityGeneration.current === generation;
        void (async () => {
          try {
            const snapshot = await client.request('mcp.trust.list', { projectRoot, sessionId: owner });
            if (!isCurrent()) return;
            const server = snapshot.servers.find((item) => item.name === command.server);
            if (server === undefined) throw new Error('mcp_server_unknown');
            setPending({ server: server.name, scope, version: snapshot.version, identityDigest: server.identityDigest,
              sessionId: owner, sessionGeneration: generation });
            push({ kind: 'meta', text: t(
              `待确认：${server.name}\n程序：${server.command}\n参数：${server.args.join(' ') || '无'}\n工作目录：${server.cwd}\n环境变量名：${server.environmentNames.join(', ') || '无'}\n它在 Shell 沙箱外运行，可访问当前 OS 用户可访问的文件和网络。输入 /mcp confirm 确认信任范围 ${scope}。`,
              `Pending trust: ${server.name}\nProgram: ${server.command}\nArguments: ${server.args.join(' ') || 'none'}\nWorking directory: ${server.cwd}\nEnvironment variable names: ${server.environmentNames.join(', ') || 'none'}\nIt runs outside the Shell sandbox and may access files and networks available to this OS user. Type /mcp confirm to trust at ${scope} scope.`,
            ) });
          } catch (error) {
            if (!isCurrent()) return;
            push({ kind: 'error', text: t(`无法读取 MCP Server：${errorCode(error) ?? errorMessage(error) ?? 'mcp_trust_list_failed'}`, `Could not read MCP server: ${errorCode(error) ?? errorMessage(error) ?? 'mcp_trust_list_failed'}`) });
          }
        })();
        return true;
      }
      if (command.action === 'revoke') {
        const scope = command.scope;
        void (async () => {
          const own = sessionId;
          try {
            const snapshot = await client.request('mcp.trust.list', { projectRoot, sessionId: own });
            const server = snapshot.servers.find((item) => item.name === command.server);
            if (server === undefined) throw new Error('mcp_server_unknown');
            await client.request('mcp.trust.set', {
              projectRoot, sessionId: own, server: command.server, identityDigest: server.identityDigest, scope, trusted: false,
              ...(scope === 'session' ? {} : { version: snapshot.version }),
            });
            // 只清除仍属于发起会话的待确认；切换后不要动新会话的卡片。
            if (!alive.current || activeSession.current !== own) return;
            setPending(null);
            push({ kind: 'meta', text: t(`已撤销 ${command.server} 的 ${scope} 信任。`, `Revoked ${scope} trust for ${command.server}.`) });
          } catch (error) {
            if (alive.current && activeSession.current === own) push({ kind: 'error', text: t(`撤销 MCP Server 信任失败：${errorCode(error) ?? errorMessage(error) ?? 'mcp_trust_failed'}`, `Could not revoke MCP server trust: ${errorCode(error) ?? errorMessage(error) ?? 'mcp_trust_failed'}`) });
          }
        })();
        return true;
      }
      if (command.action === 'tools') {
        push({ kind: 'meta', text: t(`正在启动已信任的 ${command.server} 并读取工具清单；不会调用工具。`, `Starting trusted server ${command.server} to list tools; no tools will be called.`) });
        void client.request('mcp.trust.tools', { projectRoot, sessionId, server: command.server }).then((listed) => {
          push({ kind: 'meta', text: listed.tools.map((tool) => `${tool.name}${tool.description === '' ? '' : ` · ${tool.description}`}`).join('\n') || t('此 Server 没有工具。', 'This server has no tools.') });
        }, (error: unknown) => push({ kind: 'error', text: t(`无法读取 MCP 工具：${errorCode(error) ?? 'mcp_tool_list_failed'}`, `Could not read MCP tools: ${errorCode(error) ?? 'mcp_tool_list_failed'}`) }));
        return true;
      }
      push({ kind: 'error', text: t('未知的 MCP 操作', 'Unknown MCP action') });
      return true;
    }
    if (name === 'extensions') {
      const command = parseExtensionsCommand(argument);
      if ('code' in command) {
        const [zh, en] = usageText(command.code);
        push({ kind: 'error', text: t(zh, en) });
        return true;
      }
      void (async () => {
        try {
          if ('name' in command) {
            await client.request('extensions.set', { projectRoot, name: command.name, enabled: command.action === 'on' });
            push({ kind: 'meta', text: t(
              `已${command.action === 'on' ? '启用' : '停用'} ${command.name}：下一次启动 Host 时生效。`,
              `${command.name} was ${command.action === 'on' ? 'enabled' : 'disabled'}: it takes effect the next time the Host starts.`,
            ) });
            return;
          }
          const catalog = await client.request('settings.catalog', { projectRoot });
          const lines = catalog.extensions.length === 0
            ? [t('没有已发现的用户扩展。', 'No user extensions were discovered.')]
            : catalog.extensions.map((extension) => `${extension.name} · ${extension.source === 'user-installed' ? t('用户安装', 'user installed') : t('用户配置', 'user configured')} · ${extension.enabled ? t('已启用', 'enabled') : t('已停用（下次启动不加载）', 'disabled (will not load next start)')} · ${extension.loaded ? t('已加载', 'loaded') : t('未加载', 'not loaded')}${extension.registeredTools.length === 0 ? '' : ` · ${extension.registeredTools.join(', ')}`}`);
          if (catalog.extensionDiagnostics.length > 0) {
            lines.push(t(`诊断：${catalog.extensionDiagnostics.map((item) => `${item.code}(${item.source})`).join('、')}`, `Diagnostics: ${catalog.extensionDiagnostics.map((item) => `${item.code}(${item.source})`).join(', ')}`));
          }
          if (catalog.customToolDiagnostics.length > 0) {
            lines.push(t(`自定义工具诊断：${catalog.customToolDiagnostics.map((item) => `${item.code}(${item.source})`).join('、')}`, `Custom tool diagnostics: ${catalog.customToolDiagnostics.map((item) => `${item.code}(${item.source})`).join(', ')}`));
          }
          const customTools = catalog.tools.filter((tool) => tool.source === 'custom');
          if (customTools.length > 0) {
            lines.push(t(`自定义工具：${customTools.map((tool) => tool.name).join('、')}`, `Custom tools: ${customTools.map((tool) => tool.name).join(', ')}`));
          }
          push({ kind: 'meta', text: lines.join('\n') });
        } catch (error) {
          push({ kind: 'error', text: t(`扩展信息读取失败：${errorCode(error) ?? 'extensions_catalog_failed'}`, `Could not read extensions: ${errorCode(error) ?? 'extensions_catalog_failed'}`) });
        }
      })();
      return true;
    }
    if (name === 'trust') {
      if (argument === '') {
        push({ kind: 'meta', text: t(`工作区：${projectRoot ?? ''}\n使用 /trust revoke 撤销信任并退出；工具审批仍按当前设置执行。`, `Workspace: ${projectRoot ?? ''}\nUse /trust revoke to revoke trust and exit. Tool approvals still use the current policy.`) });
      } else if (argument !== 'revoke') {
        push({ kind: 'error', text: t('用法：/trust [revoke]', 'Usage: /trust [revoke]') });
      } else if (trust === undefined) {
        push({ kind: 'error', text: t('此客户端未接入工作区信任存储', 'Workspace trust storage is unavailable in this client') });
      } else {
        void trust.revoke().then(() => exitTui(''), (error: unknown) => push({ kind: 'error', text: t(`无法撤销信任：${errorCode(error) ?? 'tui_trust_failed'}`, `Could not revoke trust: ${errorCode(error) ?? 'tui_trust_failed'}`) }));
      }
      return true;
    }
    return false;
  }, [activeSession, alive, client, exitTui, pending, projectRoot, push, reportMcpTrustOutcome, sessionId, sessionIdentityGeneration, t, trust]);

  return { handle };
}
