import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { open, parseSse, DEFAULT_RETRY } from '../dist/model/http.js';
import { listenFetchable } from './helpers/port.ts';

const SENTINEL = 'PLAN2_SYNTHETIC_PRIVATE_SENTINEL_NEVER_LOG';
const RETRY = { ...DEFAULT_RETRY, maxAttempts: 1, baseDelayMs: 1 };

type ProviderFailure = { code?: string; detail?: unknown; cause?: unknown; diagnostics?: unknown; stack?: string };

async function endpoint(
  respond: (request: IncomingMessage, response: ServerResponse) => void,
  run: (url: string) => void | Promise<void>,
): Promise<void> {
  const server = createServer(respond);
  const url = `http://127.0.0.1:${await listenFetchable(server)}`;
  try { await run(url); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function safeFailure(code: string) {
  return (error: unknown) => {
    const failure = error as ProviderFailure;
    assert.equal(failure.code, code);
    assert.equal((String(failure.detail) + String(failure.cause) + String(failure.stack)).includes(SENTINEL), false);
    assert.equal(JSON.stringify(failure.diagnostics ?? {}).includes(SENTINEL), false);
    return true;
  };
}

test('Provider HTTP failure does not expose an upstream response body', async () => {
  await endpoint((request, response) => {
    response.writeHead(401);
    response.end(`invalid authorization: ${SENTINEL}`);
  }, async (url) => {
    await assert.rejects(open(url, { method: 'POST' }, RETRY), (error) => {
      safeFailure('provider_http_error')(error);
      const failure = error as ProviderFailure;
      assert.deepEqual(failure.diagnostics, {
        category: 'authentication', status: 401, attempts: 1,
        responseReceived: true, streamReceived: false, recoverable: false,
      });
      assert.equal(JSON.stringify(failure.diagnostics).includes(url), false);
      return true;
    });
  });
});

test('Malformed SSE JSON does not expose response text through details or causes', async () => {
  await endpoint((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${SENTINEL}\n\n`);
  }, async (url) => {
    const response = await open(url, { method: 'POST' }, RETRY);
    await assert.rejects(async () => {
      for await (const event of parseSse(response.body as NonNullable<Response['body']>)) assert.fail(`unexpected event ${typeof event}`);
    }, (error) => {
      safeFailure('provider_stream_invalid')(error);
      const failure = error as { diagnostics: { category?: string; attempts?: number; responseReceived?: boolean; streamReceived?: boolean; recoverable?: boolean } };
      assert.equal(failure.diagnostics.category, 'invalid_response');
      assert.equal(failure.diagnostics.attempts, 1);
      assert.equal(failure.diagnostics.responseReceived, true);
      assert.equal(failure.diagnostics.streamReceived, true);
      assert.equal(failure.diagnostics.recoverable, false);
      return true;
    });
  });
});

test('Aborting a request settles a stream that never sends data', async () => {
  await endpoint((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': keep-alive\n\n');
  }, async (url) => {
    const controller = new AbortController();
    const response = await open(url, { method: 'POST', signal: controller.signal }, RETRY);
    const body = response.body as NonNullable<Response['body']>;
    const iteration = (async () => {
      for await (const event of parseSse(body, { signal: controller.signal })) assert.fail(`unexpected event ${typeof event}`);
    })();
    setTimeout(() => controller.abort(), 100);
    const settled = await Promise.race([
      iteration.then(() => 'resolved' as const, (error: unknown) => error),
      new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 5_000)),
    ]);
    assert.notEqual(settled, 'timed-out', 'an aborted stream must not wait for the upstream to end');
    assert.equal((settled as ProviderFailure).code, 'provider_cancelled');
  });
});

test('parseSse settles a pending read when the stream itself ignores the abort signal', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  });
  const controller = new AbortController();
  const iteration = (async () => {
    for await (const event of parseSse(stream, { signal: controller.signal })) assert.fail(`unexpected event ${typeof event}`);
  })();
  setTimeout(() => controller.abort(), 50);
  const settled = await Promise.race([
    iteration.then(() => 'resolved' as const, (error: unknown) => error),
    new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 5_000)),
  ]);
  assert.notEqual(settled, 'timed-out', 'cancelling must settle the pending read even if the stream ignores the signal');
  assert.equal((settled as ProviderFailure).code, 'provider_cancelled');
  assert.equal(cancelled, true, 'the response body must be cancelled on abort');
});

test('context overflow remains recognizable without disclosing the upstream diagnostic', async () => {
  await endpoint((request, response) => {
    response.writeHead(400);
    response.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: SENTINEL } }));
  }, async (url) => {
    await assert.rejects(open(url, { method: 'POST' }, RETRY), (error) => {
      safeFailure('provider_http_error')(error);
      assert.equal((error as ProviderFailure).detail, 'HTTP 400 context_length_exceeded');
      return true;
    });
  });
});
