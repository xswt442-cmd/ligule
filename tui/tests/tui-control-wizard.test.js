import test from 'node:test';
import assert from 'node:assert/strict';
import { controlGrantRequest, controlWizardNext, parseControlWizardInput } from '../dist/tui/control-wizard.js';

const t = (zh) => zh;

function wizard(step, values = {}) {
  return { step, values, mcpServers: ['notes'], mcpTools: ['mcp:notes/read'] };
}

test('control wizard skips confirmations that the ceilings do not require', () => {
  const readOnly = { defaultPermissionProfile: 'read-only', maxPermissionProfile: 'read-only', defaultNetwork: 'disabled', maxNetwork: 'disabled' };
  assert.equal(controlWizardNext(11, readOnly), -1, '只读且网络 disabled 不需要额外确认');
  assert.equal(controlWizardNext(11, { ...readOnly, maxNetwork: 'unrestricted' }), 14);
  assert.equal(controlWizardNext(12, { ...readOnly, maxPermissionProfile: 'workspace-write', maxNetwork: 'policy' }), -1);
  assert.equal(controlWizardNext(13, { ...readOnly, maxNetwork: 'policy' }), -1);
});

test('control wizard rejects ceilings below the defaults', () => {
  const lower = parseControlWizardInput(
    wizard(2, { defaultPermissionProfile: 'full-access' }),
    'read-only',
    t,
  );
  assert.equal(lower.kind, 'error');
  assert.match(lower.message, /权限上限不能低于默认权限/);

  const network = parseControlWizardInput(
    wizard(4, { defaultNetwork: 'unrestricted' }),
    'policy',
    t,
  );
  assert.equal(network.kind, 'error');
  assert.match(network.message, /网络上限不能低于默认网络范围/);
});

test('control wizard keeps policy lists distinct and inclusive of the default', () => {
  const duplicated = parseControlWizardInput(wizard(6, { defaultPolicy: 'ask' }), 'ask,ask', t);
  assert.equal(duplicated.kind, 'error');
  const missingDefault = parseControlWizardInput(wizard(6, { defaultPolicy: 'ask' }), 'auto,none', t);
  assert.equal(missingDefault.kind, 'error');
  const ok = parseControlWizardInput(wizard(6, { defaultPolicy: 'ask' }), 'ask,none', t);
  assert.equal(ok.kind, 'step');
  assert.deepEqual(ok.wizard.values.allowedPolicies, ['ask', 'none']);
});

test('control wizard defers MCP tool listing and aborts when trust is refused', () => {
  const servers = parseControlWizardInput(wizard(8), 'notes', t);
  assert.equal(servers.kind, 'mcp-servers');
  assert.deepEqual(servers.values.allowedMcpServers, ['notes']);
  assert.deepEqual(servers.values.allowedMcpTools, []);

  const unknown = parseControlWizardInput(wizard(8), 'other', t);
  assert.equal(unknown.kind, 'error');

  const refused = parseControlWizardInput(wizard(11), 'no', t);
  assert.equal(refused.kind, 'abort');
  assert.match(refused.message, /授权未创建/);

  const accepted = parseControlWizardInput(wizard(11), 'yes', t);
  assert.equal(accepted.kind, 'step');
  assert.equal(accepted.wizard.values.confirmWorkspaceTrust, true);
});

test('control wizard submits and maps values onto the create request', () => {
  const values = {
    name: 'grant',
    defaultPermissionProfile: 'workspace-write',
    maxPermissionProfile: 'full-access',
    defaultNetwork: 'policy',
    maxNetwork: 'unrestricted',
    defaultPolicy: 'ask',
    allowedPolicies: ['ask', 'none'],
    allowOperator: true,
    allowedMcpServers: ['notes'],
    allowedMcpTools: ['mcp:notes/read'],
    expiresAt: null,
    confirmFullAccess: true,
    confirmUnrestrictedNetwork: true,
    confirmPartialWorkspaceWrite: true,
    confirmWorkspaceTrust: true,
  };
  const done = parseControlWizardInput(wizard(13, values), 'yes', t);
  // 上限是 full-access、网络 unrestricted，第 13 步之后还要确认不受限网络。
  assert.equal(done.kind, 'step');
  assert.equal(done.wizard.step, 14);

  const request = controlGrantRequest(
    { ...values, confirmUnrestrictedNetwork: true },
    '/project',
    'v1',
  );
  assert.deepEqual(request, {
    version: 'v1',
    grantName: 'grant',
    projectRoot: '/project',
    defaultPermissionProfile: 'workspace-write',
    maxPermissionProfile: 'full-access',
    defaultNetwork: 'policy',
    maxNetwork: 'unrestricted',
    defaultPolicy: 'ask',
    allowedPolicyAsk: true,
    allowedPolicyAuto: false,
    allowedPolicyNone: true,
    allowOperator: true,
    allowedMcpServers: ['notes'],
    allowedMcpTools: ['mcp:notes/read'],
    confirmFullAccess: true,
    confirmUnrestrictedNetwork: true,
    confirmPartialWorkspaceWrite: true,
    confirmWorkspaceTrust: true,
    expiresAt: '',
  });
});
