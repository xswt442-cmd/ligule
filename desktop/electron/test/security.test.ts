import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  APP_PAGE,
  MAX_FRAME_BYTES,
  approvedPage,
  developmentCsp,
  resourcePath,
  validateDefaultName,
  validateFrame,
  validateNotification,
} from '../security.ts';

const SESSION_ID = 'b8f7a9c2-151a-4cc4-9f3f-39df5429d919';

test('development CSP requires a fixed-size nonce without allowing arbitrary scripts', () => {
  const csp = developmentCsp('a'.repeat(43) + '=');
  assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9+/]{43}='/u);
  assert.doesNotMatch(csp, /script-src[^;]*(?:unsafe-inline|unsafe-eval)/u);
  assert.throws(() => developmentCsp(undefined));
  assert.throws(() => developmentCsp("'; script-src *"));
});

function notification(target = JSON.stringify({ sessionId: SESSION_ID, projectRoot: resolve('project') })): Record<string, unknown> {
  return { title: 'ligule', body: 'Turn completed', target, openLabel: 'Open conversation' };
}

test('validateFrame accepts a JSON object exactly at the UTF-8 byte limit', () => {
  const prefix = '{"value":"';
  const suffix = '"}';
  const remainingBytes = MAX_FRAME_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  const frame = `${prefix}${'é'.repeat(remainingBytes / 2)}${suffix}`;
  assert.ok(frame.length < MAX_FRAME_BYTES);
  assert.equal(Buffer.byteLength(frame), MAX_FRAME_BYTES);
  assert.equal(validateFrame(frame), frame);
});

test('validateFrame rejects malformed, multiline, non-object, and oversized input', () => {
  for (const value of ['{', '{"a":1}\n{}', '[]', 'null', 12, null]) {
    assert.throws(() => validateFrame(value), /desktop_frame_invalid/u);
  }
  const prefix = '{"value":"';
  const suffix = '"}';
  const remainingBytes = MAX_FRAME_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  const oversized = `${prefix}${'é'.repeat(remainingBytes / 2 + 1)}${suffix}`;
  assert.throws(() => validateFrame(oversized), /desktop_frame_invalid/u);
});

test('validateDefaultName refuses path traversal and unsafe filename characters', () => {
  assert.equal(validateDefaultName('session-1.md'), 'session-1.md');
  for (const value of ['../session.md', 'folder/session.md', 'session..backup.md', 'name with space.md', 'name?.md', '.hidden.md', 'session.txt']) {
    assert.throws(() => validateDefaultName(value), /desktop_export_name_invalid/u);
  }
});

test('validateNotification accepts the fixed shape and rejects untrusted fields and values', () => {
  assert.equal(validateNotification(notification()).body, 'Turn completed');
  const invalidValues = [
    { ...notification(), extra: 'field' },
    { ...notification(), body: 'Private session content' },
    { ...notification(), title: 'ligule\u0000' },
    { ...notification(JSON.stringify({ sessionId: 'not-a-uuid', projectRoot: resolve('project') })) },
    { ...notification(JSON.stringify({ sessionId: SESSION_ID, projectRoot: 'relative/project' })) },
    { ...notification(JSON.stringify({ sessionId: SESSION_ID, projectRoot: `${resolve('project')}\u0000` })) },
  ];
  for (const value of invalidValues) assert.throws(() => validateNotification(value), /desktop_notification_invalid/u);
});

test('approvedPage requires the exact application page and rejects origin lookalikes', () => {
  assert.equal(approvedPage(APP_PAGE, APP_PAGE), true);
  assert.equal(approvedPage(`${APP_PAGE}#settings`, APP_PAGE), true);
  for (const value of [
    'app://ligule.attacker/index.html',
    'app://attacker/ligule/index.html',
    'app://user@ligule/index.html',
    'app://ligule/index.html?redirect=app://ligule/index.html',
    'app://ligule/other.html',
    'https://ligule/index.html',
  ]) assert.equal(approvedPage(value, APP_PAGE), false, value);
});

test('resourcePath rejects encoded traversal, backslashes, nulls, and unapproved origins', () => {
  const root = resolve('desktop-resource-root');
  assert.equal(resourcePath(root, 'app://ligule/'), resolve(root, 'index.html'));
  for (const address of [
    'app://ligule/%2e%2e%2fsecret.txt',
    'app://ligule/%5c..%5csecret.txt',
    'app://ligule/file%00.js',
    'app://other/index.html',
    'https://ligule/index.html',
    'file:///etc/passwd',
  ]) assert.throws(() => resourcePath(root, address), /desktop_resource_rejected/u, address);
});
