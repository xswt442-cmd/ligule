import test from 'node:test';
import assert from 'node:assert/strict';
import { controlRevokeBinding } from '../dist/tui/control-binding.js';

test('revoke confirmation keeps the version observed when the panel opened', () => {
  const opened = { version: 'v1', grants: [{ id: 'grant-a' }, { id: 'grant-b' }] };
  const bound = controlRevokeBinding(opened, 'grant-a');
  assert.deepEqual(bound, { grantId: 'grant-a', version: 'v1' });
  // 迟到的列表响应更新到 v2 时，已打开的确认仍绑定 v1。
  const later = { version: 'v2', grants: [{ id: 'grant-a' }] };
  assert.equal(controlRevokeBinding(later, 'grant-a')!.version, 'v2');
  assert.deepEqual(bound, { grantId: 'grant-a', version: 'v1' });
});

test('revoke confirmation refuses a grant that is no longer listed', () => {
  assert.equal(controlRevokeBinding({ version: 'v1', grants: [] }, 'grant-a'), null);
});
