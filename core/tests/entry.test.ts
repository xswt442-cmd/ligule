import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ENTRY_TRUSTED_UI, admitEntry } from '../dist/host/entry.js';
import { METHODS } from '../dist/host/protocol.js';
import { KernelError } from '../dist/errors.js';

const trusted = { permissionControl: true } as const;
const untrusted = { permissionControl: false } as const;

function denialOf(method: string, trust: { readonly permissionControl: boolean }, operationSession = false): string | undefined {
  try {
    admitEntry({ method, trust, operationSession });
    return undefined;
  } catch (error) {
    assert.ok(error instanceof KernelError, `${method} must fail with a KernelError`);
    return error.code;
  }
}

test('the entry table only gates methods the wire protocol declares', () => {
  for (const method of ENTRY_TRUSTED_UI.keys()) {
    assert.ok(Object.hasOwn(METHODS, method), `${method} is gated at the entry but is not declared in METHODS`);
  }
});

test('every entry-gated method is denied without the trusted local UI and allowed with it', () => {
  assert.equal(ENTRY_TRUSTED_UI.size, 20);
  const expected: Readonly<Record<string, string>> = {
    'workspace.trust': 'workspace_trust_control_unavailable',
    'session.side.create': 'side_session_trusted_ui_required',
    'view.request.ack': 'view_request_trusted_ui_required',
    'screen-capture.set': 'screen_capture_control_unavailable',
    'browser.stop': 'browser_control_trusted_ui_required',
    'browser.resume': 'browser_control_trusted_ui_required',
    'session.export': 'session_export_trusted_ui_required',
    'storage.inspect': 'storage_control_trusted_ui_required',
    'storage.cleanup.preview': 'storage_control_trusted_ui_required',
    'storage.cleanup.apply': 'storage_control_trusted_ui_required',
    'operation.start': 'operation_run_trusted_ui_required',
    'usage.diagnostics': 'request_diagnostics_trusted_ui_required',
    'agent-control.list': 'agent_control_trusted_ui_required',
    'agent-control.create': 'agent_control_trusted_ui_required',
    'agent-control.revoke': 'agent_control_trusted_ui_required',
    'mcp.trust.list': 'mcp_trust_trusted_ui_required',
    'mcp.trust.set': 'mcp_trust_trusted_ui_required',
    'mcp.trust.tools': 'mcp_trust_trusted_ui_required',
    'settings.catalog': 'settings_catalog_trusted_ui_required',
    'extensions.set': 'extensions_set_trusted_ui_required',
  };
  for (const [method, code] of Object.entries(expected)) {
    assert.equal(ENTRY_TRUSTED_UI.get(method) !== undefined, true, `${method} is missing from the entry table`);
    assert.equal(denialOf(method, untrusted), code, `${method} must be denied to a plain MCP client`);
    assert.equal(denialOf(method, trusted), undefined, `${method} must be allowed to the trusted local UI`);
  }
});

test('Operation Sessions lose the entry-gated methods even when the caller is the trusted UI', () => {
  assert.equal(denialOf('workspace.trust', trusted, true), 'operation_session_control_unavailable');
  assert.equal(denialOf('session.export', trusted, true), 'operation_session_control_unavailable');
  assert.equal(denialOf('project.file.save', trusted, true), 'operation_session_control_unavailable');
  assert.equal(denialOf('run.start', trusted, true), 'operation_session_model_run_unavailable');
  assert.equal(denialOf('operation.start', trusted, true), 'operation_session_start_unavailable');
  assert.equal(denialOf('session.open', trusted, true), undefined);
  assert.equal(denialOf('execution.wait', trusted, true), undefined);
});

test('host.ts keeps method-order gates declarative instead of scattering them in branches', () => {
  const source = readFileSync(new URL('../src/host/host.ts', import.meta.url), 'utf8').split(/\r?\n/u);
  const scattered = [];
  for (let index = 1; index < source.length; index += 1) {
    if (!/^\s*requireTrustedUi\('/u.test(source[index])) continue;
    // A gate directly after a case label (alone or at the end of a grouped label) is a method-order gate.
    const previous = source[index - 1];
    if (/^\s*case '[^']+':\s*\{?$/u.test(previous)) scattered.push(`line ${index + 1} after ${previous.trim()}`);
  }
  assert.deepEqual(scattered, [], 'method-level trusted-UI gates belong in ENTRY_TRUSTED_UI, not in branch bodies');
});
