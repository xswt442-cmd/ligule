// 外控授权的本地 MCP 配置片段：命令与参数可直接粘贴到 MCP 客户端。
import type { AgentGrant } from './app.js';

export function agentMcpConfig(grant: AgentGrant): string {
  const args = ['mcp-server', '--project', grant.projectRoot, '--grant', grant.id];
  if (grant.allowOperator) args.push('--operator');
  return JSON.stringify({ mcpServers: { ligule: { command: 'ligule', args } } }, null, 2);
}
