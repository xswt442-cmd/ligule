// 检查桌面端“安全预设”只填入 Host 已经不禁止的上限，并且不偷偷继承更宽的确认。
import assert from 'node:assert/strict';
import { applyGrantPreset, grantPreset, grantPresets } from '../../frontend/src/agent-control-presets.ts';

const CEILINGS = {
  reader: { profile: 'read-only', network: 'policy' },
  workspace: { profile: 'workspace-write', network: 'policy' },
};

function draft() {
  return {
    name: '手填的名字',
    expiresAt: '2030-01-01T00:00',
    defaultPermissionProfile: 'full-access',
    maxPermissionProfile: 'full-access',
    defaultNetwork: 'unrestricted',
    maxNetwork: 'unrestricted',
    defaultPolicy: 'auto',
    allowedPolicies: ['auto', 'none'],
    allowOperator: true,
    allowScreenCapture: true,
    confirmScreenCapture: true,
    allowedMcpServers: ['github'],
    allowedMcpTools: ['mcp:github/issue'],
    confirmFullAccess: true,
    confirmUnrestrictedNetwork: true,
    confirmPartialWorkspaceWrite: true,
    confirmWorkspaceTrust: false,
  };
}

// 两个预设都必须在 Host 允许的范围内，且从不带完整访问或无限制网络。
for (const preset of grantPresets) {
  const expected = CEILINGS[preset.id];
  assert.equal(preset.limits.maxPermissionProfile, expected.profile, `${preset.id} 的权限上限`);
  assert.equal(preset.limits.maxNetwork, expected.network, `${preset.id} 的网络上限`);
  assert.notEqual(preset.limits.maxPermissionProfile, 'full-access', `${preset.id} 不得授予完整访问`);
  assert.notEqual(preset.limits.maxNetwork, 'unrestricted', `${preset.id} 不得授予无限制网络`);
  assert.ok(preset.limits.allowedPolicies.includes(preset.limits.defaultPolicy), `${preset.id} 的默认 Policy 要在允许集合里`);
  assert.ok(preset.limits.allowedPolicies.every((policy) => policy === 'ask' || policy === 'none'), `${preset.id} 不放开自动化 Policy`);
  assert.deepEqual(preset.limits.allowedPolicies, ['ask'], `${preset.id} 只留人工批准`);
  assert.ok(preset.label.zh !== '' && preset.label.en !== '', `${preset.id} 有双语名称`);
}

// 只读预设：上限就是只读。
assert.equal(grantPreset('reader').limits.defaultPermissionProfile, 'read-only');
assert.equal(grantPreset('reader').limits.maxPermissionProfile, 'read-only');

// 工作区预设：默认仍只读，只有上限升到工作区写入。
assert.equal(grantPreset('workspace').limits.defaultPermissionProfile, 'read-only');
assert.equal(grantPreset('workspace').limits.maxPermissionProfile, 'workspace-write');

// 应用预设会把更宽的草稿收回到预设上限，并清掉不归预设所有的确认与能力。
const widened = draft();
const readOnly = applyGrantPreset(widened, 'reader');
assert.equal(readOnly.maxPermissionProfile, 'read-only');
assert.equal(readOnly.defaultNetwork, 'policy');
assert.equal(readOnly.maxNetwork, 'policy');
assert.deepEqual(readOnly.allowedPolicies, ['ask']);
assert.equal(readOnly.allowOperator, false, '预设不代答审批');
assert.equal(readOnly.allowScreenCapture, false, '预设不开启屏幕捕获');
assert.equal(readOnly.confirmFullAccess, false, '旧的完整访问确认不得继承');
assert.equal(readOnly.confirmUnrestrictedNetwork, false, '旧的无限制网络确认不得继承');
assert.equal(readOnly.confirmPartialWorkspaceWrite, false, '部分写入确认需要人来勾');
assert.equal(readOnly.confirmWorkspaceTrust, true, '创建授权本身就是信任项目的动作');
assert.deepEqual(readOnly.allowedMcpServers, []);
assert.deepEqual(readOnly.allowedMcpTools, []);

// 预设不碰它不拥有的字段：名字、到期时间、选中的工作区保持原样。
assert.equal(readOnly.name, '手填的名字');
assert.equal(readOnly.expiresAt, '2030-01-01T00:00');

// 原来的草稿不被就地改写，避免 React 状态共享同一个数组。
assert.deepEqual(widened.allowedPolicies, ['auto', 'none']);
assert.notEqual(readOnly.allowedPolicies, widened.allowedPolicies);

const workspace = applyGrantPreset(widened, 'workspace');
assert.equal(workspace.defaultPermissionProfile, 'read-only');
assert.equal(workspace.maxPermissionProfile, 'workspace-write');

// 重复应用同一预设是幂等的。
assert.deepEqual(applyGrantPreset(readOnly, 'reader'), readOnly);

console.log('桌面端安全预设检查通过');
