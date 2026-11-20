import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionNavigation } from '../src/tui/session-navigation.ts';

function navigationOf(session: { current: string | null }, aliveFlag = { current: true }) {
  return {
    alive: aliveFlag,
    session,
    navigation: createSessionNavigation({
      alive: () => aliveFlag.current,
      activeSession: () => session.current,
    }),
  };
}

test('a lease owns the switch only while its token, generation and session still match', () => {
  const session = { current: 'main' };
  const { navigation } = navigationOf(session);
  const lease = navigation.begin('main');
  assert.ok(lease !== undefined);
  assert.equal(navigation.activeToken, lease.token);
  assert.equal(navigation.isCurrent(lease), true);

  // Another session switch invalidates the lease without a finish call.
  navigation.invalidate();
  assert.equal(navigation.isCurrent(lease), false);
});

test('one switch runs at a time and a second claim reports the busy slot', () => {
  const session = { current: 'main' };
  const { navigation } = navigationOf(session);
  const first = navigation.begin('main');
  assert.ok(first !== undefined);
  assert.equal(navigation.begin('main'), undefined);
  assert.equal(navigation.finish(first), true);
  assert.ok(navigation.begin('main') !== undefined);
});

test('a stale finish leaves the newer lease in place', () => {
  const session = { current: 'main' };
  const { navigation } = navigationOf(session);
  const first = navigation.begin('main');
  assert.ok(first !== undefined);
  navigation.invalidate();
  navigation.finish(first);
  const second = navigation.begin('main');
  assert.ok(second !== undefined);
  assert.equal(navigation.finish(first), false);
  assert.equal(navigation.activeToken, second.token);
  assert.equal(navigation.isCurrent(second), true);
});

test('a lease stops being current when the view dies or moves to another session', () => {
  const session = { current: 'a' };
  const alive = { current: true };
  const { navigation } = navigationOf(session, alive);
  const lease = navigation.begin('a');
  assert.ok(lease !== undefined);
  session.current = 'b';
  assert.equal(navigation.isCurrent(lease), false);
  session.current = 'a';
  alive.current = false;
  assert.equal(navigation.isCurrent(lease), false);
});

test('entering counts the first session separately from later switches', () => {
  const session = { current: 'a' };
  const { navigation } = navigationOf(session);
  const first = navigation.begin('a');
  assert.ok(first !== undefined);
  assert.equal(navigation.finish(first), true);
  assert.equal(navigation.entered(), false);
  const second = navigation.begin('a');
  assert.ok(second !== undefined);
  assert.equal(navigation.entered(), true);
  assert.equal(navigation.isCurrent(second), false);
});
