import type { BrowserSupport } from '../capability/browser.js';
import { assertBrowserArguments, browserToolPolicy, BROWSER_SERVER } from '../capability/browser-policy.js';
import type { MediaStore } from '../capability/media.js';
import { createMcpRegistry, type McpRegistry, type NormalizedMcpServerConfig } from '../capability/mcp.js';
import { KernelError } from '../kernel/error.js';
import { permissionDenial } from '../kernel/permission.js';
import { createMcpPlugin, type McpAuthorization } from '../tools/mcp.js';
import { assertDelegationMcpServer, assertDelegationMcpTool, type DelegationGrant } from './agent-control.js';
import { mcpServerTrust, mcpTrustKey, mcpTrustPathOf } from './mcp-trust.js';
import type { HostSessionBase } from './types.js';

interface SessionMcpContext {
  readonly projectRoot: string;
  readonly configuredServers: readonly NormalizedMcpServerConfig[];
  readonly browser: BrowserSupport;
  readonly state: Pick<HostSessionBase, 'permission' | 'permissionChanging' | 'browserPaused' | 'mcpTrust' | 'childMcp'>;
  currentServers(): Promise<readonly NormalizedMcpServerConfig[]>;
  activeProjectGrant(): Promise<DelegationGrant | undefined>;
  supportsImages(): boolean;
}

export function createSessionMcp({ projectRoot, configuredServers, browser, state, currentServers, activeProjectGrant, supportsImages }: SessionMcpContext) {
  const configuredServer = (name: string) => configuredServers.find(server => server.name === name);

  function assertServerAccess(server: string): void {
    if (server !== BROWSER_SERVER) return;
    if (state.permissionChanging) throw new KernelError('permission_change_in_progress');
    const denied = permissionDenial(state.permission, 'external');
    if (denied !== undefined) throw new KernelError(denied.code, { detail: denied.reason });
    if (state.browserPaused) throw new KernelError('browser_stopped');
  }

  async function authorizeServer(server: string): Promise<void> {
    if (server === BROWSER_SERVER) {
      assertServerAccess(server);
      await browser.verify();
    }
    const configured = configuredServer(server);
    if (configured === undefined) throw new KernelError('mcp_server_unknown', { detail: server });
    const current = (await currentServers()).find(entry => entry.name === server);
    if (current === undefined || current.identityDigest !== configured.identityDigest) {
      throw new KernelError('mcp_server_config_changed', { detail: server });
    }
    const sessionTrust = state.mcpTrust.get(mcpTrustKey(server, configured.identityDigest));
    const trust = sessionTrust ?? await mcpServerTrust(mcpTrustPathOf(), projectRoot, server, configured.identityDigest);
    if (trust?.trusted !== true) throw new KernelError('mcp_server_untrusted', { detail: server });
    const grant = await activeProjectGrant();
    if (grant !== undefined) assertDelegationMcpServer(grant, server);
  }

  const authorization: McpAuthorization = {
    authorizeServer,
    async authorizeTool(server, tool) {
      await authorizeServer(server);
      if (server === BROWSER_SERVER) {
        if (browserToolPolicy(server, tool, { type: 'object', properties: {} }) === undefined) throw new KernelError('browser_tool_denied');
        if (tool === 'browser_take_screenshot' && !supportsImages()) throw new KernelError('model_image_input_unsupported');
      }
      const grant = await activeProjectGrant();
      if (grant !== undefined) assertDelegationMcpTool(grant, `mcp:${server}/${tool}`);
    },
    authorizeArguments(server, tool, args) {
      if (server === BROWSER_SERVER) assertBrowserArguments(tool, args);
    },
    identityDigest: server => configuredServer(server)?.identityDigest,
  };

  async function registryFor(sessionId: string) {
    const servers = await Promise.all(configuredServers.map(server => server.name === BROWSER_SERVER ? browser.session(sessionId) : server));
    return createMcpRegistry(servers, {
      toolPolicy: browserToolPolicy,
      assertServerAccess,
      afterCall: name => name === BROWSER_SERVER ? browser.clearSession(sessionId) : Promise.resolve(),
    });
  }
  const pluginFor = (registry: McpRegistry, media: MediaStore) =>
    createMcpPlugin(registry, authorization, { media, sourceFor: server => server === BROWSER_SERVER ? 'browser' : undefined });

  return {
    registryFor,
    pluginFor,
    async child(childId: string, media: MediaStore) {
      const registry = await registryFor(childId);
      state.childMcp.set(registry, childId);
      return {
        plugin: pluginFor(registry, media),
        async close() {
          try {
            await registry.close();
            await browser.closeSession(childId);
          } finally {
            state.childMcp.delete(registry);
          }
        },
      };
    },
  };
}
