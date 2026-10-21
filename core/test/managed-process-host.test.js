import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createDelegationGrant, delegationPathOf, listDelegationGrants, requireDelegationGrant } from '../dist/host/agent-control.js';
import { detectPermissionCapabilities } from '../dist/capability/permission-capabilities.js';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { waitFor, withTuiHost } from './helpers/tui-host.js';

const windowsWorkspaceWrite = createPermissionContext('workspace-write', 'unrestricted', {
  filesystemRead: 'partial', filesystemWrite: 'partial', network: 'partial', process: 'full',
}, {
  profiles: { readOnly: 'partial', workspaceWrite: 'partial' },
  limitations: ['Windows workspace-write has partial isolation.'],
  partialWorkspaceWriteConfirmationRequired: true,
  partialWorkspaceWriteConfirmed: true,
});

async function availableLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.notEqual(address, null);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForUnavailable(url) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      await response.body?.cancel();
    } catch {
      return;
    }
    await delay(20);
  }
  assert.fail(`server at ${url} remained reachable`);
}

test('Host-managed server survives the tool return and Session close terminates its process tree', {
  skip: process.platform !== 'win32',
  timeout: 45_000,
}, async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const port = await availableLoopbackPort();
    const serverPath = join(projectDirectory, 'server.mjs');
    const url = `http://127.0.0.1:${port}/`;
    await writeFile(serverPath, "import { createServer } from 'node:http';\nconst port = Number(process.argv[2]);\ncreateServer((request, response) => response.end('host-managed-ready')).listen(port, '127.0.0.1', () => console.log(`listening ${port}`));\n");
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    const approvals = [];
    client.onRequest((message) => {
      if (message.method !== 'approval.request') return undefined;
      approvals.push(message.params);
      return { decision: 'allow' };
    });

    const invoke = async (args) => {
      await client.request('run.start', {
        sessionId,
        input: JSON.stringify({ tool: 'managed_process', args }),
      });
      const record = await client.request('session.read', { sessionId });
      const result = record.events.filter((event) => event.kind === 'tool' && event.tool === 'managed_process').at(-1)?.result;
      assert.notEqual(result?.failed, true, JSON.stringify(result));
      return result.content;
    };

    const started = await invoke({
      action: 'start',
      command: `node "${serverPath.replaceAll('\\', '/')}" ${port}`,
      readyUrl: url,
    });
    assert.equal(started.status, 'running');
    assert.equal(started.port, port);
    assert.equal('pid' in started, false, 'the exposed handle does not label the Guardian PID as the server PID');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].tool, 'exec');
    assert.ok(approvals[0].scriptBinding);
    const response = await fetch(url);
    assert.equal(await response.text(), 'host-managed-ready');

    const status = await invoke({ action: 'status', id: started.id });
    assert.equal(status.status, 'running');
    assert.match(status.logs, /listening/);
    await client.request('session.close', { sessionId });
    await assert.rejects(() => fetch(url));
  }, {
    permissionControl: true,
    permission: windowsWorkspaceWrite,
    testDirectory: join(process.cwd(), 'testplace'),
  });
});

test('Linux bubblewrap Host-managed server survives the tool return and Session close terminates it', {
  skip: process.platform !== 'linux',
  timeout: 45_000,
}, async (t) => {
  const capabilities = await detectPermissionCapabilities({ platform: 'linux' });
  if (capabilities.profiles.workspaceWrite === 'unavailable') {
    t.skip(capabilities.limitations.join('; '));
    return;
  }
  const permission = createPermissionContext('workspace-write', 'unrestricted', capabilities.capabilities, {
    profiles: capabilities.profiles,
    limitations: capabilities.limitations,
    partialWorkspaceWriteConfirmed: false,
  });
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const port = await availableLoopbackPort();
    const serverPath = join(projectDirectory, 'server.mjs');
    const url = `http://127.0.0.1:${port}/`;
    await writeFile(serverPath, "import { createServer } from 'node:http';\nconst port = Number(process.argv[2]);\ncreateServer((request, response) => response.end('linux-managed-ready')).listen(port, '127.0.0.1', () => console.log(`listening ${port}`));\n");
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', {
      sessionId,
      input: JSON.stringify({
        tool: 'managed_process',
        args: {
          action: 'start',
          command: `node "${serverPath}" ${port}`,
          readyUrl: url,
        },
      }),
    });
    const events = (await client.request('session.read', { sessionId })).events;
    const started = events.filter((event) => event.kind === 'tool' && event.tool === 'managed_process').at(-1)?.result.content;
    assert.equal(started.status, 'running');
    assert.equal(started.port, port);
    assert.equal(await (await fetch(url)).text(), 'linux-managed-ready');

    await client.request('session.close', { sessionId });
    await waitForUnavailable(url);
  }, {
    permission,
    permissionControl: true,
    testDirectory: join(process.cwd(), 'testplace'),
  });
});

test('run.cancel terminates the Session-managed process tree while the Agent is waiting on its next model request', {
  skip: process.platform !== 'win32' && process.platform !== 'linux',
  timeout: 45_000,
}, async (t) => {
  let permission;
  if (process.platform === 'win32') {
    permission = windowsWorkspaceWrite;
  } else {
    const capabilities = await detectPermissionCapabilities({ platform: 'linux' });
    if (capabilities.profiles.workspaceWrite === 'unavailable') {
      t.skip(capabilities.limitations.join('; '));
      return;
    }
    permission = createPermissionContext('workspace-write', 'unrestricted', capabilities.capabilities, {
      profiles: capabilities.profiles,
      limitations: capabilities.limitations,
    });
  }

  await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
    const port = await availableLoopbackPort();
    const serverPath = join(projectDirectory, 'server.mjs');
    const url = `http://127.0.0.1:${port}/`;
    await writeFile(serverPath, "import { createServer } from 'node:http';\nconst port = Number(process.argv[2]);\ncreateServer((request, response) => response.end('cancel-managed-ready')).listen(port, '127.0.0.1', () => console.log(`listening ${port}`));\n");
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    const run = client.request('run.start', {
      sessionId,
      input: JSON.stringify({
        tool: 'managed_process',
        args: {
          action: 'start',
          command: `node "${serverPath.replaceAll('\\', '/')}" ${port}`,
          readyUrl: url,
        },
      }),
    });
    const outcome = run.then(() => undefined, (error) => error);
    await waitFor(() => providerRequests.length >= 2, { within: 15_000, every: 10 });
    assert.equal((await fetch(url)).status, 200);
    assert.deepEqual(await client.request('run.cancel', { sessionId }), { cancelled: true });
    await waitForUnavailable(url);
    const failure = await outcome;
    assert.ok(failure instanceof Error, 'the cancelled model run does not report success');
    assert.ok(['loop_cancelled', 'provider_cancelled'].includes(failure.code), failure.code);
  }, {
    delayMs: 1_500,
    permissionControl: true,
    permission,
    testDirectory: join(process.cwd(), 'testplace'),
  });
});

test('revoking the owning Agent Control Grant stops the Session server and releases its port', {
  skip: process.platform !== 'win32',
  timeout: 45_000,
}, async () => {
  let grant;
  await withTuiHost(async ({ client, sessionId, projectDirectory, directory }) => {
    const port = await availableLoopbackPort();
    const serverPath = join(projectDirectory, 'server.mjs');
    const url = `http://127.0.0.1:${port}/`;
    await writeFile(serverPath, "import { createServer } from 'node:http';\nconst port = Number(process.argv[2]);\ncreateServer((request, response) => response.end('grant-managed-ready')).listen(port, '127.0.0.1', () => console.log(`listening ${port}`));\n");
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', {
      sessionId,
      input: JSON.stringify({
        tool: 'managed_process',
        args: {
          action: 'start',
          command: `node "${serverPath.replaceAll('\\', '/')}" ${port}`,
          readyUrl: url,
        },
      }),
    });
    const events = (await client.request('session.read', { sessionId })).events;
    const started = events.filter((event) => event.kind === 'tool' && event.tool === 'managed_process').at(-1)?.result.content;
    assert.equal(started.status, 'running');
    assert.equal((await fetch(url)).status, 200);

    const store = await listDelegationGrants(grant.storePath);
    const revoked = await client.request('agent-control.revoke', { grantId: grant.id, version: store.version });
    assert.ok(revoked.grants.find((entry) => entry.id === grant.id)?.revokedAt);
    await waitForUnavailable(url);
    await assert.rejects(client.request('status.get', { sessionId }), { code: 'agent_control_grant_revoked' });
  }, {
    permissionControl: true,
    permission: windowsWorkspaceWrite,
    testDirectory: join(process.cwd(), 'testplace'),
    agentControl: async ({ projectDirectory, homeDirectory }) => {
      const storePath = delegationPathOf(homeDirectory);
      const initial = await listDelegationGrants(storePath);
      const created = await createDelegationGrant(storePath, {
        name: 'managed process lifecycle test',
        projectRoot: projectDirectory,
        defaultPermissionProfile: 'workspace-write',
        maxPermissionProfile: 'workspace-write',
        defaultNetwork: 'unrestricted',
        maxNetwork: 'unrestricted',
        defaultPolicy: 'ask',
        allowedPolicies: ['ask'],
        allowOperator: true,
        confirmFullAccess: false,
        confirmUnrestrictedNetwork: true,
        confirmWorkspaceTrust: true,
        confirmPartialWorkspaceWrite: true,
        expiresAt: null,
      }, initial.version);
      grant = { id: created.grants[0].id, storePath };
      return {
        grantId: grant.id,
        storePath,
        operator: true,
        validate: () => requireDelegationGrant(storePath, grant.id, projectDirectory),
      };
    },
  });
});
