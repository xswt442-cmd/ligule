import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionWindow } from '../../frontend/src/session-window.ts';

test('a live record applies only when it continues the applied range', () => {
  const window = new SessionWindow();
  assert.equal(window.loadedThrough, 0);

  window.reset(5);
  assert.deepEqual(window.incoming({ seq: 6 }), { apply: true });
  assert.deepEqual(window.incoming({ seq: 6 }), { apply: false, reason: 'duplicate' });
  assert.deepEqual(window.incoming({ seq: 5 }), { apply: false, reason: 'duplicate' });

  // A jump is reported before the view shows records out of order; the cursor
  // stays put so the caller can fetch the missing page.
  assert.deepEqual(window.incoming({ seq: 8 }), { apply: false, reason: 'gap', missingFrom: 7, missingTo: 7 });
  assert.equal(window.loadedThrough, 6);

  assert.deepEqual(window.incoming({ seq: 7 }), { apply: true });
  assert.deepEqual(window.incoming({ seq: 8 }), { apply: true });
  assert.equal(window.loadedThrough, 8);
});

test('adopting a fetched page stops at its own gap instead of skipping records', () => {
  const window = new SessionWindow(5);
  assert.deepEqual(window.adopt([{ seq: 6 }, { seq: 7 }, { seq: 8 }]).map(record => record.seq), [6, 7, 8]);
  assert.equal(window.loadedThrough, 8);

  const stale = window.adopt([{ seq: 8 }, { seq: 9 }]);
  assert.deepEqual(stale.map(record => record.seq), [9], 'records already applied are not projected twice');

  const beyond = window.adopt([{ seq: 11 }, { seq: 12 }]);
  assert.deepEqual(beyond, [], 'a page that starts past the cursor changes nothing');
  assert.equal(window.loadedThrough, 9);

  assert.deepEqual(window.adopt([{ seq: 10 }]).map(record => record.seq), [10]);
  assert.equal(window.loadedThrough, 10);
});

test('records without a sequence number are shown but do not move the cursor', () => {
  const window = new SessionWindow(3);
  assert.deepEqual(window.incoming({}), { apply: true });
  assert.equal(window.loadedThrough, 3);
  assert.deepEqual(window.adopt([{ seq: 4 }, {}]).map(record => record.seq), [4, undefined]);
  assert.equal(window.loadedThrough, 4);
});

test('a snapshot cursor must be a non-negative integer', () => {
  assert.throws(() => new SessionWindow(-1), TypeError);
  const window = new SessionWindow(2);
  assert.throws(() => window.reset(1.5), TypeError);
  assert.equal(window.loadedThrough, 2);
});
