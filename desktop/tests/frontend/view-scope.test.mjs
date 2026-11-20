import assert from 'node:assert/strict';
import test from 'node:test';
import { createViewScope } from '../../frontend/src/view-scope.ts';

test('a token stays current until the scope changes', () => {
  const scope = createViewScope();
  const token = scope.capture('command-a');
  assert.equal(scope.isCurrent(token), true);
  scope.bump();
  assert.equal(scope.isCurrent(token), false);
  assert.equal(scope.isCurrent(scope.capture('command-a')), true);
});

test('forgetting one reference only invalidates that reference', () => {
  const scope = createViewScope();
  const first = scope.capture('command-a');
  const second = scope.capture('command-b');
  scope.forget('command-a');
  assert.equal(scope.isCurrent(first), false);
  assert.equal(scope.isCurrent(second), true);
  assert.equal(scope.isCurrent(scope.capture('command-a')), true);
  assert.equal(scope.scope(), 0);
});

test('scope tokens do not depend on a reference', () => {
  const scope = createViewScope();
  const token = scope.capture();
  scope.forget('command-a');
  assert.equal(scope.isCurrent(token), true);
  scope.bump();
  assert.equal(scope.isCurrent(token), false);
});

test('a token captured before a key was forgotten cannot be revived', () => {
  const scope = createViewScope();
  const stale = scope.capture('command-a');
  scope.forget('command-a');
  scope.forget('command-a');
  assert.equal(scope.isCurrent(stale), false);
  const current = scope.capture('command-a');
  assert.equal(scope.isCurrent(current), true);
  scope.bump();
  assert.equal(scope.isCurrent(current), false);
});
