import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDelegationGrant, listDelegationGrants, requireDelegationGrant, revokeDelegationGrant } from '../core/dist/host/agent-control.js';
import { createConnection } from '../core/dist/host/connection.js';
import { createMemoryConnectionPair } from '../core/dist/host/memory.js';
import { serveHost } from '../core/dist/host/host.js';
import { hostProviderFromConfig } from '../core/dist/host/provider.js';
import { modeDirectories } from '../core/dist/kernel/modes.js';
import { withTuiHost } from '../core/tests/helpers/tui-host.js';

const testDirectory = fileURLToPath(new URL('../testplace/', import.meta.url));
const evidenceLog = fileURLToPath(new URL('../testplace/p4-run-scope.log', import.meta.url));

async function logEvidence(message) {
  await mkdir(join(evidenceLog, '..'), { recursive: true });
  await appendFile(evidenceLog, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

function grantInput(projectRoot, name, expiresAt = null) {
  return {
    name, projectRoot,
    defaultPermissionProfile: 'read-only', maxPermissionProfile: 'read-only',
    defaultNetwork: 'policy', maxNetwork: 'policy', defaultPolicy: 'ask',
    allowedPolicies: ['ask'], allowOperator: false,
    confirmFullAccess: false, confirmUnrestrictedNetwork: false, expiresAt,
  };
}

function startGrantHost({ config, projectDirectory, directory, storePath, grantId }) {
  const pair = createMemoryConnectionPair();
  const homeDirectory = join(directory, 'home');
  const host = serveHost({
    ...pair.host,
    config,
    provider: hostProviderFromConfig(config),
    policy: config.policy,
    modeName: 'minimal',
    modePaths: modeDirectories(projectDirectory, fileURLToPath(new URL('../core/modes/', import.meta.url)), homeDirectory),
    agentControl: {
      grantId, storePath, operator: false,
      validate: () => requireDelegationGrant(storePath, grantId, projectDirectory),
    },
  });
  return {
    client: createConnection(pair.client),
    async stop() { pair.client.output.end(); await host.release(); },
  };
}

test('run receipt and result reads stay within the active Grant scope and validate it before lookup', async () => {
  let storePath;
  let firstGrantId;
  let secondGrantId;
  let expiredGrantId;
  await withTuiHost(async ({ client, config, sessionId, projectDirectory, directory }) => {
    const first = await client.request('run.submit', {
      sessionId, origin: 'controller', input: 'scope-bound result', requestKey: 'scope-key',
    });
    await client.request('run.wait', { sessionId, origin: 'controller', runId: first.runId });
    const ownReceipt = await client.request('run.receipt', { projectRoot: projectDirectory, sessionId, requestKey: 'scope-key' });
    assert.equal(ownReceipt.runId, first.runId);
    const ownResult = await client.request('run.result', { projectRoot: projectDirectory, sessionId, runId: first.runId, offset: 0 });
    assert.match(ownResult.json, /scope-bound result/u);

    await client.request('session.close', { sessionId });
    const peer = startGrantHost({ config, projectDirectory, directory, storePath, grantId: secondGrantId });
    try {
      await peer.client.request('session.open', { sessionId });
      await assert.rejects(peer.client.request('run.receipt', { projectRoot: projectDirectory, sessionId, runId: first.runId }), { code: 'run_not_found' });
      await assert.rejects(peer.client.request('run.result', { projectRoot: projectDirectory, sessionId, runId: first.runId }), { code: 'run_not_found' });
      const second = await peer.client.request('run.submit', {
        sessionId, origin: 'controller', input: 'scope-bound result', requestKey: 'scope-key',
      });
      assert.notEqual(second.runId, first.runId, 'a second Grant must not reuse another Grant’s idempotency key');
      await peer.client.request('run.wait', { sessionId, origin: 'controller', runId: second.runId });

      const otherProject = join(directory, 'other-project');
      await mkdir(otherProject);
      await assert.rejects(peer.client.request('run.receipt', { projectRoot: otherProject, sessionId, runId: second.runId }), { code: 'agent_control_project_forbidden' });
      await assert.rejects(peer.client.request('run.result', { projectRoot: otherProject, sessionId, runId: second.runId }), { code: 'agent_control_project_forbidden' });

      const snapshot = await listDelegationGrants(storePath);
      await revokeDelegationGrant(storePath, secondGrantId, snapshot.version);
      await assert.rejects(peer.client.request('run.receipt', { projectRoot: projectDirectory, sessionId, runId: second.runId }), { code: 'agent_control_grant_revoked' });
      await assert.rejects(peer.client.request('run.result', { projectRoot: projectDirectory, sessionId, runId: second.runId }), { code: 'agent_control_grant_revoked' });
    } finally { await peer.stop(); }

    await delay(1_600);
    const expiredPeer = startGrantHost({ config, projectDirectory, directory, storePath, grantId: expiredGrantId });
    try {
      await assert.rejects(expiredPeer.client.request('run.receipt', { projectRoot: projectDirectory, sessionId, runId: first.runId }), { code: 'agent_control_grant_expired' });
      await assert.rejects(expiredPeer.client.request('run.result', { projectRoot: projectDirectory, sessionId, runId: first.runId }), { code: 'agent_control_grant_expired' });
    } finally { await expiredPeer.stop(); }
    await logEvidence('PASS same-project Grant isolation, revoke/expiry authorization, and cross-workspace denial via real Hosts and Grant storage');
  }, {
    testDirectory,
    agentControl: async ({ directory, projectDirectory }) => {
      storePath = join(directory, 'agent-control.json');
      const empty = await listDelegationGrants(storePath);
      const first = await createDelegationGrant(storePath, grantInput(projectDirectory, 'P4 first scope'), empty.version);
      firstGrantId = first.grants[0].id;
      const second = await createDelegationGrant(storePath, grantInput(projectDirectory, 'P4 second scope'), first.version);
      secondGrantId = second.grants.find(grant => grant.name === 'P4 second scope').id;
      const expiresAt = new Date(Date.now() + 1_200).toISOString();
      const third = await createDelegationGrant(storePath, grantInput(projectDirectory, 'P4 expiring scope', expiresAt), second.version);
      expiredGrantId = third.grants.find(grant => grant.name === 'P4 expiring scope').id;
      return {
        grantId: firstGrantId, storePath, operator: false,
        validate: () => requireDelegationGrant(storePath, firstGrantId, projectDirectory),
      };
    },
  });
});

test('trusted local UI can read both run scopes without changing session history', async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory, sessionDirectory }) => {
    const human = await client.request('run.submit', { sessionId, origin: 'human', input: 'human scope result', requestKey: 'human-key' });
    await client.request('run.wait', { sessionId, origin: 'human', runId: human.runId });
    const controller = await client.request('run.submit', { sessionId, origin: 'controller', input: 'controller scope result', requestKey: 'controller-key' });
    await client.request('run.wait', { sessionId, origin: 'controller', runId: controller.runId });
    const recordPath = join(sessionDirectory, `${sessionId}.jsonl`);
    const beforeReads = await readFile(recordPath);

    assert.equal((await client.request('run.receipt', { projectRoot: projectDirectory, sessionId, runId: human.runId })).state, 'completed');
    assert.equal((await client.request('run.receipt', { projectRoot: projectDirectory, sessionId, runId: controller.runId })).state, 'completed');
    assert.match((await client.request('run.result', { projectRoot: projectDirectory, sessionId, runId: human.runId })).json, /human scope result/u);
    assert.match((await client.request('run.result', { projectRoot: projectDirectory, sessionId, runId: controller.runId })).json, /controller scope result/u);
    assert.deepEqual(await readFile(recordPath), beforeReads, 'trusted reads must not append history');
    await logEvidence('PASS trusted local UI read human/controller run results without changing Session JSONL');
  }, { testDirectory, permissionControl: true });
});
