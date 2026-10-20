import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDelegationGrant, listDelegationGrants, requireDelegationGrant, revokeDelegationGrant, assertDelegationPermission, assertDelegationPolicy } from '../dist/host/agent-control.js';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { withTuiHost } from './helpers/tui-host.js';

const root = resolve('testplace');

async function fixture(run) {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'agent-control-'));
  const projectRoot = join(directory, 'project');
  const storePath = join(directory, 'agent-control.json');
  await mkdir(projectRoot);
  try { await run({ directory, projectRoot, storePath }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function input(projectRoot, overrides = {}) {
  return {
    name: 'Codex local task',
    projectRoot,
    defaultPermissionProfile: 'workspace-write',
    maxPermissionProfile: 'workspace-write',
    defaultNetwork: 'policy',
    maxNetwork: 'policy',
    defaultPolicy: 'ask',
    allowedPolicies: ['ask', 'auto'],
    allowOperator: false,
    confirmFullAccess: false,
    confirmUnrestrictedNetwork: false,
    expiresAt: null,
    ...overrides,
  };
}

test('delegation grants bind to a canonical project and reject a different project', async () => {
  await fixture(async ({ projectRoot, directory, storePath }) => {
    const empty = await listDelegationGrants(storePath);
    const created = await createDelegationGrant(storePath, input(projectRoot), empty.version);
    assert.equal(created.grants.length, 1);
    assert.equal(created.grants[0].projectRoot, projectRoot);
    assert.equal(created.grants[0].source, 'trusted-ui');
    const stored = JSON.parse(await readFile(storePath, 'utf8'));
    assert.equal(stored.audit[0].source, 'trusted-ui');
    assert.equal((await requireDelegationGrant(storePath, created.grants[0].id, projectRoot)).id, created.grants[0].id);
    await assert.rejects(requireDelegationGrant(storePath, created.grants[0].id, directory), { code: 'agent_control_project_forbidden' });
    await assert.rejects(createDelegationGrant(storePath, input(projectRoot), empty.version), { code: 'agent_control_version_stale' });
  });
});

test('existing grants without a recorded origin remain usable without inventing one', async () => {
  await fixture(async ({ projectRoot, storePath }) => {
    const created = await createDelegationGrant(storePath, input(projectRoot), (await listDelegationGrants(storePath)).version);
    const legacy = JSON.parse(await readFile(storePath, 'utf8'));
    delete legacy.grants[0].source;
    delete legacy.audit[0].source;
    await writeFile(storePath, `${JSON.stringify(legacy)}\n`);

    const loaded = await listDelegationGrants(storePath);
    assert.equal(loaded.grants[0].source, 'legacy');
    assert.equal((await requireDelegationGrant(storePath, created.grants[0].id, projectRoot)).source, 'legacy');

    await revokeDelegationGrant(storePath, created.grants[0].id, loaded.version);
    const rewritten = JSON.parse(await readFile(storePath, 'utf8'));
    assert.equal(rewritten.grants[0].source, 'legacy');
    assert.equal(rewritten.audit[0].source, 'legacy');
  });
});

test('full access and unrestricted network require separate grant confirmations', async () => {
  await fixture(async ({ projectRoot, storePath }) => {
    const empty = await listDelegationGrants(storePath);
    const elevated = input(projectRoot, {
      defaultPermissionProfile: 'full-access', maxPermissionProfile: 'full-access',
      defaultNetwork: 'unrestricted', maxNetwork: 'unrestricted',
      confirmFullAccess: true, confirmUnrestrictedNetwork: true,
    });
    await assert.rejects(createDelegationGrant(storePath, { ...elevated, confirmFullAccess: false }, empty.version), { code: 'agent_control_full_access_confirmation_required' });
    await assert.rejects(createDelegationGrant(storePath, { ...elevated, confirmUnrestrictedNetwork: false }, empty.version), { code: 'agent_control_unrestricted_network_confirmation_required' });
    const created = await createDelegationGrant(storePath, elevated, empty.version);
    assert.equal(created.grants[0].confirmedFullAccess, true);
    assert.equal(created.grants[0].confirmedUnrestrictedNetwork, true);
  });
});

test('delegation ceilings reject permission and policy escalation', async () => {
  await fixture(async ({ projectRoot, storePath }) => {
    const created = await createDelegationGrant(storePath, input(projectRoot), (await listDelegationGrants(storePath)).version);
    const grant = created.grants[0];
    assertDelegationPermission(grant, 'read-only', 'disabled');
    assertDelegationPermission(grant, 'workspace-write', 'policy');
    assert.throws(() => assertDelegationPermission(grant, 'full-access', 'policy'), { code: 'agent_control_permission_exceeds_grant' });
    assert.throws(() => assertDelegationPermission(grant, 'read-only', 'unrestricted'), { code: 'agent_control_permission_exceeds_grant' });
    assertDelegationPolicy(grant, 'auto');
    assert.throws(() => assertDelegationPolicy(grant, 'never'), { code: 'agent_control_policy_exceeds_grant' });
  });
});

test('revoked and expired grants cannot be used', async () => {
  await fixture(async ({ projectRoot, storePath }) => {
    const created = await createDelegationGrant(storePath, input(projectRoot), (await listDelegationGrants(storePath)).version);
    const revoked = await revokeDelegationGrant(storePath, created.grants[0].id, created.version);
    await assert.rejects(requireDelegationGrant(storePath, created.grants[0].id, projectRoot), { code: 'agent_control_grant_revoked' });
    await assert.rejects(revokeDelegationGrant(storePath, created.grants[0].id, revoked.version), { code: 'agent_control_grant_revoked' });

    const next = await createDelegationGrant(storePath, input(projectRoot), revoked.version);
    const stored = JSON.parse(await readFile(storePath, 'utf8'));
    stored.grants[1].expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(storePath, `${JSON.stringify(stored)}\n`);
    await assert.rejects(requireDelegationGrant(storePath, next.grants[1].id, projectRoot), { code: 'agent_control_grant_expired' });
  });
});

test('trusted Host clients can create and revoke grants while untrusted Host clients cannot', async () => {
  await withTuiHost(async ({ client, projectDirectory }) => {
    const before = await client.request('agent-control.list', {});
    const created = await client.request('agent-control.create', {
      version: before.version,
      grantName: 'desktop test',
      projectRoot: projectDirectory,
      defaultPermissionProfile: 'read-only', maxPermissionProfile: 'workspace-write',
      defaultNetwork: 'policy', maxNetwork: 'policy',
      defaultPolicy: 'ask', allowedPolicyAsk: true, allowedPolicyAuto: false, allowedPolicyNever: false, allowOperator: false,
      confirmFullAccess: false, confirmUnrestrictedNetwork: false, confirmWorkspaceTrust: true, expiresAt: '',
    });
    assert.equal(created.grants.length, 1);
    const revoked = await client.request('agent-control.revoke', { grantId: created.grants[0].id, version: created.version });
    assert.ok(revoked.grants[0].revokedAt);
  }, { permissionControl: true });

  await withTuiHost(async ({ client }) => {
    await assert.rejects(client.request('agent-control.list', {}), { code: 'agent_control_trusted_ui_required' });
  });
});

test('Windows partial Agent Control grants require explicit project-trust confirmation', async () => {
  const permission = createPermissionContext('read-only', 'policy', {
    filesystemRead: 'partial', filesystemWrite: 'partial', network: 'partial', process: 'full',
  }, {
    profiles: { readOnly: 'partial', workspaceWrite: 'partial' },
    limitations: ['Windows workspace-write has partial isolation.'],
    partialWorkspaceWriteConfirmationRequired: true,
  });
  await withTuiHost(async ({ client, projectDirectory }) => {
    const before = await client.request('agent-control.list', {});
    const grant = {
      version: before.version,
      grantName: 'partial workspace test',
      projectRoot: projectDirectory,
      defaultPermissionProfile: 'read-only',
      maxPermissionProfile: 'workspace-write',
      defaultNetwork: 'policy',
      maxNetwork: 'policy',
      defaultPolicy: 'ask',
      allowedPolicyAsk: true,
      allowedPolicyAuto: false,
      allowedPolicyNever: false,
      allowOperator: false,
      confirmFullAccess: false,
      confirmUnrestrictedNetwork: false,
      confirmWorkspaceTrust: true,
      expiresAt: '',
    };
    await assert.rejects(client.request('agent-control.create', grant), {
      code: 'permission_partial_sandbox_confirmation_required',
    });
    const created = await client.request('agent-control.create', {
      ...grant, confirmPartialWorkspaceWrite: true,
    });
    assert.equal(created.grants[0].confirmedPartialWorkspaceWrite, true);
  }, { permissionControl: true, permission });
});

test('a delegated Host enforces the project, permission, policy and operator limits on every request', async () => {
  let grant;
  await withTuiHost(async ({ client, sessionId, projectDirectory, directory }) => {
    assert.equal((await client.request('status.get', { sessionId })).permission.profile, 'read-only');
    const changed = await client.request('session.configure', { sessionId, permissionProfile: 'workspace-write' });
    assert.equal(changed.permission.profile, 'workspace-write');
    await assert.rejects(
      client.request('session.configure', { sessionId, permissionProfile: 'full-access' }),
      { code: 'agent_control_permission_exceeds_grant' },
    );
    await assert.rejects(
      client.request('session.configure', { sessionId, policy: 'never' }),
      { code: 'agent_control_policy_exceeds_grant' },
    );
    await assert.rejects(
      client.request('session.create', { projectRoot: directory }),
      { code: 'agent_control_project_forbidden' },
    );
    const grantList = await listDelegationGrants(grant.storePath);
    await assert.rejects(client.request('agent-control.create', {
      version: grantList.version, grantName: 'forged', projectRoot: projectDirectory,
      defaultPermissionProfile: 'read-only', maxPermissionProfile: 'read-only',
      defaultNetwork: 'policy', maxNetwork: 'policy', defaultPolicy: 'ask',
      allowedPolicyAsk: true, allowedPolicyAuto: false, allowedPolicyNever: false,
      allowOperator: false, confirmFullAccess: false, confirmUnrestrictedNetwork: false, confirmWorkspaceTrust: true, expiresAt: '',
    }), { code: 'agent_control_trusted_ui_required' });
    const records = await client.request('session.read', { sessionId });
    assert.equal(records.events.filter((event) => event.kind === 'sessionPermission').at(-1).source, 'agent-control');
    const revoked = await revokeDelegationGrant(grant.storePath, grant.id, (await listDelegationGrants(grant.storePath)).version);
    assert.equal(revoked.grants[0].revokedAt !== null, true);
    await assert.rejects(client.request('status.get', { sessionId }), { code: 'agent_control_grant_revoked' });
  }, {
    permission: createPermissionContext('read-only', 'policy', {
      filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
    }),
    agentControl: async ({ directory, projectDirectory }) => {
      const storePath = join(directory, 'agent-control.json');
      const created = await createDelegationGrant(storePath, input(projectDirectory), (await listDelegationGrants(storePath)).version);
      grant = { storePath, id: created.grants[0].id };
      return {
        grantId: grant.id, storePath, operator: true,
        validate: () => requireDelegationGrant(storePath, grant.id, projectDirectory),
      };
    },
  });
});

test('session policy overrides survive reopening and remain inside the active grant ceiling', async () => {
  let grant;
  await withTuiHost(async ({ client, sessionId, sessionDirectory }) => {
    await client.request('policy.set', { sessionId, mode: 'ask' });
    await client.request('session.close', { sessionId });
    await client.request('session.open', { sessionId });
    assert.equal((await client.request('status.get', { sessionId })).policy, 'ask');

    await client.request('session.close', { sessionId });
    const path = join(sessionDirectory, `${sessionId}.jsonl`);
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    const state = lines.filter((event) => event.kind === 'sessionPolicy').at(-1);
    assert.ok(state);
    state.override = 'never';
    const forged = `${lines.map((event) => JSON.stringify(event)).join('\n')}\n`;
    await writeFile(path, forged);
    await assert.rejects(client.request('session.open', { sessionId }), { code: 'agent_control_policy_exceeds_grant' });
    assert.equal(await readFile(path, 'utf8'), forged);
  }, {
    agentControl: async ({ directory, projectDirectory }) => {
      const storePath = join(directory, 'agent-control.json');
      const created = await createDelegationGrant(storePath, input(projectDirectory, { allowedPolicies: ['ask'] }), (await listDelegationGrants(storePath)).version);
      grant = { storePath, id: created.grants[0].id };
      return {
        grantId: grant.id, storePath, operator: true,
        validate: () => requireDelegationGrant(storePath, grant.id, projectDirectory),
      };
    },
  });
});

test('a grant without operator permission cannot change session settings', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    await assert.rejects(
      client.request('session.configure', { sessionId, permissionProfile: 'workspace-write' }),
      { code: 'agent_control_operator_required' },
    );
  }, {
    permission: createPermissionContext('read-only', 'policy', {
      filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
    }),
    agentControl: async ({ directory, projectDirectory }) => {
      const storePath = join(directory, 'agent-control.json');
      const created = await createDelegationGrant(storePath, input(projectDirectory), (await listDelegationGrants(storePath)).version);
      return {
        grantId: created.grants[0].id, storePath, operator: false,
        validate: () => requireDelegationGrant(storePath, created.grants[0].id, projectDirectory),
      };
    },
  });
});
