import { realpath } from 'node:fs/promises';
import { BROWSER_SERVER } from '../../capability/browser-policy.js';
import { createMcpRegistry, type NormalizedMcpServerConfig } from '../../capability/mcp.js';
import { KernelError } from '../../kernel/error.js';
import { readExtensionState, writeExtensionState } from '../../kernel/extension-state.js';
import { permissionDenial } from '../../kernel/permission.js';
import { workspaceIdentity } from '../../workspace-identity.js';
import { listMcpTrust, mcpServerTrust, mcpTrustKey, mcpTrustPathOf, setMcpServerTrust } from '../mcp-trust.js';
import { requiredString, type HostMethodParams } from '../protocol.js';
import type { HostSessionState, ProjectEnvironment } from '../types.js';

type McpEnvironment = Pick<ProjectEnvironment, 'projectRoot' | 'mcpConfigs' | 'extensions'>;
type McpSession<Environment extends McpEnvironment> =
  Pick<HostSessionState, 'session' | 'mcpTrust' | 'mcp' | 'permission' | 'browserPaused' | 'browser'>
  & { readonly environment: Environment };

interface McpExtensionContext<Environment extends McpEnvironment, State extends McpSession<Environment>> {
  environmentFor(projectRoot: unknown): Promise<Environment>;
  open(id: string): State;
  sessions(): Iterable<State>;
  currentMcpConfigs(environment: Environment): Promise<NormalizedMcpServerConfig[]>;
  stopMcpServersWithChangedConfig(environment: Environment, configs: NormalizedMcpServerConfig[]): Promise<void>;
  revokeSessionMcp(state: State, name: string): Promise<void>;
}

export function createMcpExtensionHandlers<Environment extends McpEnvironment, State extends McpSession<Environment>>(
  context: McpExtensionContext<Environment, State>,
) {
  function sessionIn(env: Environment, id: unknown): State {
    const state = context.open(requiredString(id, 'sessionId'));
    if (state.environment !== env) throw new KernelError('session_project_forbidden');
    return state;
  }

  async function refreshedConfigs(env: Environment) {
    const configs = await context.currentMcpConfigs(env);
    await context.stopMcpServersWithChangedConfig(env, configs);
    return configs;
  }

  async function currentServer(env: Environment, name: string) {
    const configs = await refreshedConfigs(env);
    const server = configs.find(item => item.name === name);
    if (server === undefined) throw new KernelError('mcp_server_unknown', { detail: name });
    return server;
  }

  function requireMatchingServer(state: State, server: NormalizedMcpServerConfig) {
    const configured = state.environment.mcpConfigs.find(item => item.name === server.name);
    if (configured?.identityDigest !== server.identityDigest) throw new KernelError('mcp_session_config_stale');
  }

  return {
    async 'mcp.trust.list'({ projectRoot, sessionId }: HostMethodParams) {
      const env = await context.environmentFor(projectRoot);
      const session = sessionId === undefined ? undefined : sessionIn(env, sessionId);
      const configured = await refreshedConfigs(env);
      const store = await listMcpTrust(mcpTrustPathOf());
      const servers = await Promise.all(configured.map(async (server) => {
        const sessionTrust = session?.mcpTrust.get(mcpTrustKey(server.name, server.identityDigest));
        const projectIdentity = workspaceIdentity(await realpath(env.projectRoot));
        const projectTrust = store.entries.find(entry => entry.scope === 'project' && entry.projectIdentity === projectIdentity
          && entry.server === server.name && entry.identityDigest === server.identityDigest);
        const userTrust = store.entries.find(entry => entry.scope === 'user'
          && entry.server === server.name && entry.identityDigest === server.identityDigest);
        const show = (entry: typeof sessionTrust | typeof projectTrust) =>
          entry === undefined ? null : { source: entry.source, trusted: entry.trusted, updatedAt: entry.updatedAt };
        const scopes = { session: show(sessionTrust), project: show(projectTrust), user: show(userTrust) };
        const trust = scopes.session !== null ? { scope: 'session' as const, ...scopes.session }
          : scopes.project !== null ? { scope: 'project' as const, ...scopes.project }
            : scopes.user !== null ? { scope: 'user' as const, ...scopes.user } : null;
        return {
          name: server.name, command: server.command, args: server.args, cwd: server.cwd,
          environmentNames: server.environmentNames, identityDigest: server.identityDigest, trustScopes: scopes, trust,
        };
      }));
      return { version: store.version, servers };
    },
    async 'mcp.trust.set'(params: HostMethodParams) {
      const env = await context.environmentFor(params.projectRoot);
      const serverName = requiredString(params.server, 'server');
      const expectedIdentity = requiredString(params.identityDigest, 'identityDigest');
      const server = await currentServer(env, serverName);
      if (server.identityDigest !== expectedIdentity) throw new KernelError('mcp_server_config_changed', { detail: serverName });
      const scope = requiredString(params.scope, 'scope');
      if (scope !== 'session' && scope !== 'project' && scope !== 'user') throw new KernelError('mcp_trust_scope_invalid');
      const { trusted } = params;
      if (typeof trusted !== 'boolean') throw new KernelError('protocol_args_invalid', { detail: 'trusted must be a boolean' });
      if (trusted && (params.confirmTrust !== true || params.confirmExternalAccess !== true)) {
        throw new KernelError('mcp_trust_confirmation_required');
      }
      if (scope === 'session') {
        const state = sessionIn(env, params.sessionId);
        requireMatchingServer(state, server);
        const change = { source: 'trusted-ui' as const, trusted, updatedAt: new Date().toISOString() };
        await state.session.append({
          kind: 'sessionMcpTrust', ignorable: true, server: serverName, identityDigest: server.identityDigest, ...change,
        });
        state.mcpTrust.set(mcpTrustKey(serverName, server.identityDigest), change);
        if (!trusted) await context.revokeSessionMcp(state, serverName);
        return { scope, server: serverName, trusted, updatedAt: change.updatedAt };
      }
      const store = await setMcpServerTrust(mcpTrustPathOf(), {
        scope, projectRoot: env.projectRoot, server: serverName, identityDigest: server.identityDigest, trusted,
      }, requiredString(params.version, 'version'));
      if (!trusted) {
        for (const state of context.sessions()) {
          const current = state.environment.mcpConfigs.find(item => item.name === serverName);
          if (current === undefined) continue;
          if (scope === 'project' && state.environment !== env) continue;
          if (scope === 'user' && current.identityDigest !== server.identityDigest) continue;
          const sessionTrust = state.mcpTrust.get(mcpTrustKey(serverName, current.identityDigest));
          const effective = sessionTrust ?? await mcpServerTrust(mcpTrustPathOf(), state.environment.projectRoot, serverName, current.identityDigest);
          if (effective?.trusted !== true) await context.revokeSessionMcp(state, serverName);
        }
      }
      return { version: store.version, scope, server: serverName, trusted };
    },
    async 'mcp.trust.tools'(params: HostMethodParams) {
      const env = await context.environmentFor(params.projectRoot);
      const serverName = requiredString(params.server, 'server');
      const server = await currentServer(env, serverName);
      const session = params.sessionId === undefined ? undefined : sessionIn(env, params.sessionId);
      if (session !== undefined) requireMatchingServer(session, server);
      const sessionTrust = session?.mcpTrust.get(mcpTrustKey(serverName, server.identityDigest));
      const trust = sessionTrust ?? await mcpServerTrust(mcpTrustPathOf(), env.projectRoot, serverName, server.identityDigest);
      if (trust?.trusted !== true) throw new KernelError('mcp_server_untrusted', { detail: serverName });
      const view = async (registry: ReturnType<typeof createMcpRegistry>) => {
        const tools = await registry.toolsOf(serverName, AbortSignal.timeout(25_000));
        return { server: serverName, identityDigest: server.identityDigest, tools: tools.map(({ name, description, digest }) => ({ name, description, digest })) };
      };
      if (serverName === BROWSER_SERVER) {
        if (session === undefined) throw new KernelError('browser_session_required');
        const denied = permissionDenial(session.permission, 'external');
        if (denied !== undefined) throw new KernelError(denied.code, { detail: denied.reason });
        if (session.browserPaused) throw new KernelError('browser_stopped');
        await session.browser.verify();
        return await view(session.mcp);
      }
      const registry = createMcpRegistry([server]);
      try { return await view(registry); }
      finally { await registry.close(); }
    },
    async 'extensions.set'(params: HostMethodParams) {
      const env = await context.environmentFor(params.projectRoot);
      const name = requiredString(params.name, 'name');
      const { enabled } = params;
      if (typeof enabled !== 'boolean') throw new KernelError('protocol_args_invalid', { detail: 'enabled must be a boolean' });
      const known = new Set([
        ...Object.values(env.extensions.installNames ?? {}),
        ...(env.extensions.disabled ?? []).map(entry => entry.name),
      ]);
      if (!known.has(name)) {
        throw new KernelError('extensions_set_unknown', { detail: `${name} is not an extension installed in the user extensions directory` });
      }
      const state = await readExtensionState();
      if (state.unavailable !== undefined) {
        throw new KernelError('extensions_set_state_unavailable', { detail: state.unavailable });
      }
      const disabled = new Set(state.disabled);
      if (enabled) disabled.delete(name);
      else disabled.add(name);
      await writeExtensionState(undefined, [...disabled]);
      return { name, enabled, applies: 'next-start' };
    },
  } satisfies Record<string, (params: HostMethodParams) => Promise<unknown>>;
}
