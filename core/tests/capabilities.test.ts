import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPERATION_SESSION_METHODS,
  isOperationSessionMethod,
  operationSessionDenial,
} from '../dist/host/capabilities.js';
import { METHODS } from '../dist/host/protocol.js';

const declared = Object.keys(METHODS).sort();

test('the Operation Session table only names methods the wire protocol declares', () => {
  for (const method of OPERATION_SESSION_METHODS) {
    assert.ok(
      Object.hasOwn(METHODS, method),
      `${method} is allowed for Operation Sessions but is not declared in METHODS`,
    );
  }
});

test('every declared method is classified as allowed or denied for Operation Sessions', () => {
  for (const method of declared) {
    const allowed = isOperationSessionMethod(method);
    assert.equal(allowed, OPERATION_SESSION_METHODS.has(method), `${method} allowlist and predicate disagree`);
    assert.equal(
      operationSessionDenial(method) === undefined,
      allowed,
      `${method} is allowed by one check and denied by another`,
    );
    assert.ok(
      allowed || operationSessionDenial(method)?.startsWith('operation_session_'),
      `${method} is neither allowed nor given an operation_session_ denial code`,
    );
  }
});

test('Operation Sessions keep the command controls and lose everything else', () => {
  for (const method of [
    'session.open', 'session.close', 'session.read', 'session.observe',
    'status.get', 'execution.status', 'execution.logs', 'execution.wait', 'execution.cancel',
  ]) {
    assert.equal(operationSessionDenial(method), undefined, `${method} must stay available`);
  }
  assert.equal(OPERATION_SESSION_METHODS.size, 9);
  for (const method of ['run.start', 'run.submit', 'run.cancel', 'operation.start', 'session.export', 'project.file.save']) {
    assert.equal(operationSessionDenial(method) === undefined, false, `${method} must be denied`);
  }
  assert.equal(operationSessionDenial('run.start'), 'operation_session_model_run_unavailable');
  assert.equal(operationSessionDenial('run.submit'), 'operation_session_model_run_unavailable');
  assert.equal(operationSessionDenial('run.cancel'), 'operation_session_run_cancel_unavailable');
  assert.equal(operationSessionDenial('operation.start'), 'operation_session_start_unavailable');
  assert.equal(operationSessionDenial('project.file.save'), 'operation_session_control_unavailable');
});
