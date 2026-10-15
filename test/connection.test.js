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

test('an output close prevents both queued and later inbound requests from executing', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const connection = createConnection({ input, output });
  const dispatched = [];
  connection.onRequest(({ method }) => {
    dispatched.push(method);
    return { performed: true };
  });

  try {
    // The first line has already scheduled its dispatch when the reply channel closes.
    input.write(`${JSON.stringify({ id: 'before-close', method: 'tool.write' })}\n`);
    output.emit('close');
    input.write(`${JSON.stringify({ id: 'after-close', method: 'tool.delete' })}\n`);
    await delay(0);
    assert.deepEqual(dispatched, [], 'neither RPC may mutate state without a reply channel');
    await assert.rejects(connection.request('status.get'), (error) => error.code === 'connection_closed');
  } finally {
    input.destroy();
    output.destroy();
  }
});

test('closing the output during an inbound batch stops dispatching later lines', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const connection = createConnection({ input, output });
  const dispatched = [];
  connection.onNotification(() => { output.emit('close'); });
  connection.onRequest(({ method }) => { dispatched.push(method); return 'ok'; });

  try {
    input.write(
      `${JSON.stringify({ notify: 'shutdown' })}\n`
      + `${JSON.stringify({ id: 'late-request', method: 'tool.write' })}\n`,
    );
    await delay(0);
    assert.deepEqual(dispatched, [], 'remaining lines in the same chunk must be dropped');
  } finally {
    input.destroy();
    output.destroy();
  }
});


test('transport close invokes onClose once across all shutdown event paths', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  let count = 0;
  const connection = createConnection({ input, output, onClose: () => { count += 1; } });
  output.emit('close');
  input.emit('end');
  input.emit('close');
  output.emit('error', new Error('late output fault'));
  await delay(0);
  assert.equal(count, 1);
  await assert.rejects(connection.request('status.get'), { code: 'connection_closed' });
  input.destroy();
  output.destroy();
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
