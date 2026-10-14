import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from '../dist/host/connection.js';

test('a request made after the input closes rejects instead of waiting forever', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const connection = createConnection({ input, output });
  input.end();
  await new Promise((resolve) => input.once('end', resolve));

  await assert.rejects(
    Promise.race([
      connection.request('status.get'),
      delay(100).then(() => { throw new Error('the request stayed pending'); }),
    ]),
    (error) => error.code === 'connection_closed',
  );
});

test('a synchronous response arriving during write settles the request', async () => {
  const input = new PassThrough();
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString('utf8'));
      input.write(`${JSON.stringify({ id: request.id, result: 'ok' })}\n`);
      callback();
    },
  });
  const connection = createConnection({ input, output });

  try {
    assert.equal(await Promise.race([
      connection.request('status.get'),
      delay(100).then(() => { throw new Error('the synchronous response was lost'); }),
    ]), 'ok');
  } finally {
    input.destroy();
    output.destroy();
  }
});
