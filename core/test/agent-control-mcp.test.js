import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createDelegationGrant, listDelegationGrants, revokeDelegationGrant } from '../dist/host/agent-control.js';
import { setTrusted } from '../dist/kernel/workspace-trust.js';

const testplace = resolve('testplace');
const runner = fileURLToPath(new URL('./fixtures/agent-control-mcp-server.mjs', import.meta.url));

async function fixture(run) {
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'agent-control-mcp-'));
  const projectRoot = join(directory, 'project');
  const otherProject = join(directory, 'other-project');
  const home = join(directory, 'ligule-home');
  await Promise.all([mkdir(projectRoot), mkdir(otherProject), mkdir(home)]);
  try { await run({ directory, projectRoot, otherProject, home }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function connect(projectRoot, home, grantId, operator) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [runner, projectRoot, grantId ?? '', operator ? 'operator' : ''],
    cwd: projectRoot,
    env: { ...process.env, LIGULE_HOME: home },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'agent-control-acceptance', version: 'test' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

function codeOf(result) {
  const first = result.content?.find((item) => item.type === 'text');
  if (first === undefined) return undefined;
  try { return JSON.parse(first.text).code; } catch { return undefined; }
}

test('a real stdio MCP process uses its grant ceiling and detects revocation', async () => {
  await fixture(async ({ projectRoot, otherProject, home }) => {
    const trustPath = join(home, 'tui-trust.json');
    const storePath = join(home, 'agent-control.json');
    await setTrusted(projectRoot, true, trustPath);
    const input = {
      name: 'stdio acceptance', projectRoot,
      defaultPermissionProfile: 'read-only', maxPermissionProfile: 'workspace-write',
      defaultNetwork: 'policy', maxNetwork: 'policy',
      defaultPolicy: 'ask', allowedPolicies: ['ask', 'auto'], allowOperator: true,
      confirmFullAccess: false, confirmUnrestrictedNetwork: false, expiresAt: null,
    };
    const created = await createDelegationGrant(storePath, input, (await listDelegationGrants(storePath)).version);
    const grant = created.grants[0];
    const { client, stderr } = await connect(projectRoot, home, grant.id, true);
    try {
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === 'ligule_session_create'));
      assert.ok(listed.tools.some((tool) => tool.name === 'ligule_run_await'));
      assert.equal(listed.tools.some((tool) => tool.name.includes('agent-control.create')), false);

      const made = await client.callTool({
        name: 'ligule_session_create',
        arguments: { projectRoot, initial: { permission: { profile: 'workspace-write', network: 'policy' }, policy: 'auto' } },
      });
      assert.equal(made.isError, undefined);
      const sessionId = made.structuredContent.sessionId;
      assert.equal(typeof sessionId, 'string');

      const config = await client.callTool({ name: 'ligule_session_configure', arguments: { sessionId } });
      assert.equal(config.isError, undefined, `${JSON.stringify(config)}\n${stderr()}`);
      assert.equal(config.structuredContent.effective.permission.profile, 'workspace-write');
      assert.equal(config.structuredContent.effective.permission.network, 'policy');
      assert.equal(config.structuredContent.delegation.maxPermissionProfile, 'workspace-write');
      assert.equal(config.structuredContent.delegation.maxNetwork, 'policy');
      assert.equal(config.structuredContent.effective.policy.mode, 'auto');

      const missingRun = await client.callTool({ name: 'ligule_run_await', arguments: { operationId: 'missing', timeoutMs: 0 } });
      assert.equal(missingRun.isError, true);
      assert.equal(codeOf(missingRun), 'operation_not_found');

      const tooHigh = await client.callTool({
        name: 'ligule_session_configure',
        arguments: { sessionId, changes: { permission: { profile: 'full-access' } } },
      });
      assert.equal(tooHigh.isError, true);
      assert.equal(codeOf(tooHigh), 'agent_control_permission_exceeds_grant');
      const crossProject = await client.callTool({
        name: 'ligule_session_create', arguments: { projectRoot: otherProject },
      });
      assert.equal(crossProject.isError, true);
      assert.equal(codeOf(crossProject), 'control_project_forbidden');

      const revoked = await revokeDelegationGrant(storePath, grant.id, (await listDelegationGrants(storePath)).version);
      assert.equal(revoked.grants[0].revokedAt !== null, true);
      const afterRevoke = await client.callTool({ name: 'ligule_session_configure', arguments: { sessionId } });
      assert.equal(afterRevoke.isError, true);
      assert.equal(codeOf(afterRevoke), 'agent_control_grant_revoked');
    } finally {
      await client.close();
    }
  });
});

test('operator mode without a grant still cannot elevate permission', async () => {
  await fixture(async ({ projectRoot, home }) => {
    await setTrusted(projectRoot, true, join(home, 'tui-trust.json'));
    const { client, stderr } = await connect(projectRoot, home, undefined, true);
    try {
      const made = await client.callTool({ name: 'ligule_session_create', arguments: { projectRoot } });
      assert.equal(made.isError, undefined);
      const sessionId = made.structuredContent.sessionId;
      const current = await client.callTool({ name: 'ligule_session_configure', arguments: { sessionId } });
      assert.equal(current.structuredContent?.effective?.permission?.profile, 'read-only', `${JSON.stringify(current)}\n${stderr()}`);
      const elevate = await client.callTool({
        name: 'ligule_session_configure',
        arguments: { sessionId, changes: { permission: { profile: 'workspace-write' } } },
      });
      assert.equal(elevate.isError, true);
      assert.equal(codeOf(elevate), 'permission_control_unavailable');
    } finally { await client.close(); }
  });
});
