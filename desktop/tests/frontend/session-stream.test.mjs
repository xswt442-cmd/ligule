import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionStreamBuffer } from '../../frontend/src/session-stream.ts';

test('keeps interleaved session output isolated and returns snapshots', () => {
  const streams = new SessionStreamBuffer();
  const first = streams.append('session-a', 'text', 'A1');
  assert.deepEqual(first, { text: 'A1', reasoning: '' });

  streams.append('session-b', 'reasoning', 'B1');
  streams.append('session-a', 'reasoning', 'A thought');
  streams.append('session-a', 'text', 'A2');

  assert.deepEqual(streams.read('session-a'), { text: 'A1A2', reasoning: 'A thought' });
  assert.deepEqual(streams.read('session-b'), { text: '', reasoning: 'B1' });
  assert.deepEqual(first, { text: 'A1', reasoning: '' }, 'previous reads are detached snapshots');
  assert.equal(streams.append('session-a', 'tool', 'ignored'), null);
});

test('recorded output settles only its own stream and completed turns clear it', () => {
  const streams = new SessionStreamBuffer();
  streams.append('session-a', 'text', 'answer');
  streams.append('session-a', 'reasoning', 'thought');
  streams.append('session-b', 'text', 'background');

  assert.deepEqual(streams.settle('session-a', 'assistant'), { text: '', reasoning: 'thought' });
  assert.deepEqual(streams.read('session-b'), { text: 'background', reasoning: '' });
  assert.deepEqual(streams.settle('session-a', 'reasoning'), { text: '', reasoning: '' });
  assert.deepEqual(streams.read('session-a'), { text: '', reasoning: '' });

  streams.clear('session-b');
  assert.deepEqual(streams.read('session-b'), { text: '', reasoning: '' });
});
