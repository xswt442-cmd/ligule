import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnosticSummary } from '../../frontend/src/diagnostics.ts';

test('diagnostic summary includes useful runtime state and excludes private session data', () => {
  const summary = diagnosticSummary({
    info: { name: 'Ligule', version: '0.0.6', packaged: true, platform: 'win32', architecture: 'x64', electronVersion: '44.7.0', build: null },
    hostNodeVersion: 'v24.21.0',
    status: {
      sessionId: 'private-session-id', running: false, mode: 'minimal', policy: 'ask',
      permission: { profile: 'read-only', network: 'policy', capabilities: { filesystemRead: 'full', filesystemWrite: 'unavailable', network: 'policy', process: 'full' }, workspaceTrusted: false },
      denials: { total: 1, consecutive: 0 }, tools: ['read'], eventCount: 4,
      transcript: 'private transcript', projectRoot: 'C:\\private\\project',
    },
    connected: true,
    counts: { sent: 8, received: 7 },
    waiting: 1,
    logCount: 3,
  });
  const parsed = JSON.parse(summary);
  assert.equal(parsed.application.version, '0.0.6');
  assert.equal(parsed.hostNodeVersion, 'v24.21.0');
  assert.equal(parsed.session.permission.profile, 'read-only');
  assert.equal(parsed.hostLogLineCount, 3);
  for (const privateValue of ['private-session-id', 'private transcript', 'C:\\private\\project']) assert.equal(summary.includes(privateValue), false);
});
