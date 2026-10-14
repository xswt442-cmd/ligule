import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
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

test('closing the input rejects pending and future requests', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const connection = createConnection({ input, output });
  const pending = assert.rejects(connection.request('status.get'), (error) => error.code === 'connection_closed');

  input.destroy();
  await once(input, 'close');

  await Promise.race([
    pending,
    delay(100).then(() => { throw new Error('the pending request stayed open after the input closed'); }),
  ]);
  await assert.rejects(
    Promise.race([
      connection.request('status.get'),
      delay(100).then(() => { throw new Error('a new request stayed open after the input closed'); }),
    ]),
    (error) => error.code === 'connection_closed',
  );
  output.destroy();
});

test('an input error reports the original fault and rejects pending and future requests', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const faults = [];
  const connection = createConnection({ input, output, onFault: (error) => faults.push(error) });
  const pending = assert.rejects(connection.request('status.get'), (error) => error.code === 'connection_closed');
  const failure = new Error('input failed');
  const errorEvent = once(input, 'error');
  const closeEvent = new Promise((resolve) => input.once('close', resolve));

  input.destroy(failure);
  assert.equal((await errorEvent)[0], failure);
  await closeEvent;

  await Promise.race([
    pending,
    delay(100).then(() => { throw new Error('the pending request stayed open after an input error'); }),
  ]);
  assert.deepEqual(faults, [failure]);
  await assert.rejects(connection.request('status.get'), (error) => error.code === 'connection_closed');
  output.destroy();
});

test('an output error reports the original fault and rejects pending and future requests', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const faults = [];
  const connection = createConnection({ input, output, onFault: (error) => faults.push(error) });
  const pending = assert.rejects(connection.request('status.get'), (error) => error.code === 'connection_closed');
  const failure = new Error('output failed');
  const errorEvent = once(output, 'error');
  const closeEvent = new Promise((resolve) => output.once('close', resolve));

  output.destroy(failure);
  assert.equal((await errorEvent)[0], failure);
  await closeEvent;

  await Promise.race([
    pending,
    delay(100).then(() => { throw new Error('the pending request stayed open after an output error'); }),
  ]);
  assert.deepEqual(faults, [failure]);
  await assert.rejects(connection.request('status.get'), (error) => error.code === 'connection_closed');
  input.destroy();
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
