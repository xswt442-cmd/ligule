import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createMessagesProvider, DEFAULT_RETRY } from '../dist/index.js';
import { listenFetchable } from './helpers/port.ts';

const API_KEY_ENV = 'LIGULE_HTTP_FAULT_TEST_KEY';
const FAST_RETRY = { ...DEFAULT_RETRY, baseDelayMs: 1 };

function provider(baseUrl, retry = FAST_RETRY) {
  return createMessagesProvider({ baseUrl, model: 'http-fault-test', apiKeyEnv: API_KEY_ENV, retry });
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function withEndpoint(respond, run) {
  const requests = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the real request body */ }
    const record = {
      method: request.method,
      url: request.url,
      responseClosed: new Promise((resolve) => response.once('close', resolve)),
    };
    requests.push(record);
    await respond(requests.length, response);
  });
  const baseUrl = `http://127.0.0.1:${await listenFetchable(server)}`;
  process.env[API_KEY_ENV] = 'synthetic-http-fault-key';
  try {
    await run(baseUrl, requests);
  } finally {
    delete process.env[API_KEY_ENV];
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function okEmpty(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
}

test('real HTTP 429 and 500/503 responses retry only until success or configured exhaustion', async () => {
  for (const status of [429, 500, 503]) {
    await withEndpoint((attempt, response) => {
      if (attempt < 3) {
        response.writeHead(status, { 'content-type': 'text/plain' });
        response.end('controlled local upstream failure');
      } else okEmpty(response);
    }, async (baseUrl, requests) => {
      assert.deepEqual(await collect(provider(baseUrl).stream({})), [{ type: 'finish', reason: 'stop' }]);
      assert.equal(requests.length, 3, `${status} then success has three actual requests`);
    });

    await withEndpoint((_attempt, response) => {
      response.writeHead(status);
      response.end('controlled local upstream failure');
    }, async (baseUrl, requests) => {
      await assert.rejects(
        () => collect(provider(baseUrl, { ...FAST_RETRY, maxAttempts: 2 }).stream({})),
        (error) => error.code === 'provider_http_error' && error.detail.startsWith(`HTTP ${status}`),
      );
      assert.equal(requests.length, 2, `${status} exhaustion respects maxAttempts`);
    });
  }
});

test('permanent 400, 401, and 403 responses fail without another HTTP request', async () => {
  for (const status of [400, 401, 403]) {
    await withEndpoint((_attempt, response) => {
      response.writeHead(status);
      response.end('permanent local rejection');
    }, async (baseUrl, requests) => {
      await assert.rejects(
        () => collect(provider(baseUrl).stream({})),
        (error) => error.code === 'provider_http_error' && error.detail.startsWith(`HTTP ${status}`),
      );
      assert.equal(requests.length, 1, `${status} is not retried`);
    });
  }
});

test('disabled 429, 5xx, and transport retry categories fail after one real request', async () => {
  for (const [status, retry] of [
    [429, { ...FAST_RETRY, retry429: false }],
    [503, { ...FAST_RETRY, retry5xx: false }],
  ]) {
    await withEndpoint((_attempt, response) => {
      response.writeHead(status);
      response.end('retry category disabled');
    }, async (baseUrl, requests) => {
      await assert.rejects(
        () => collect(provider(baseUrl, retry).stream({})),
        (error) => error.code === 'provider_http_error' && error.detail.startsWith(`HTTP ${status}`),
      );
      assert.equal(requests.length, 1, `${status} retry disabled means one request`);
    });
  }

  await withEndpoint((_attempt, response) => {
    response.socket.destroy();
  }, async (baseUrl, requests) => {
    await assert.rejects(
      () => collect(provider(baseUrl, { ...FAST_RETRY, retryTransport: false }).stream({})),
      (error) => error.code === 'provider_transport_failed',
    );
    assert.equal(requests.length, 1, 'transport retry disabled means one request');
  });
});

test('connection refusal and socket close before response headers use bounded transport retries', async () => {
  const server = createServer();
  const port = await listenFetchable(server);
  await new Promise((resolve) => server.close(resolve));
  const refusedUrl = `http://127.0.0.1:${port}`;
  process.env[API_KEY_ENV] = 'synthetic-http-fault-key';
  try {
    await assert.rejects(
      () => collect(provider(refusedUrl, { ...FAST_RETRY, maxAttempts: 2 }).stream({})),
      (error) => error.code === 'provider_transport_failed',
    );
  } finally {
    delete process.env[API_KEY_ENV];
  }

  await withEndpoint((_attempt, response) => {
    response.socket.destroy();
  }, async (baseUrl, requests) => {
    await assert.rejects(
      () => collect(provider(baseUrl, { ...FAST_RETRY, maxAttempts: 2 }).stream({})),
      (error) => error.code === 'provider_transport_failed',
    );
    assert.equal(requests.length, 2, 'pre-header socket closes are retried only to the configured bound');
  });
});

test('once SSE has delivered content, a socket interruption never replays the HTTP request', async () => {
  await withEndpoint((_attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{}}}\n\n');
    response.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
    response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n');
    response.flushHeaders();
    setTimeout(() => response.socket.destroy(), 20);
  }, async (baseUrl, requests) => {
    const seen = [];
    await assert.rejects(async () => {
      for await (const event of provider(baseUrl).stream({})) seen.push(event);
    }, (error) => error.code === 'provider_stream_interrupted');
    assert.deepEqual(seen, [{ type: 'text', text: 'partial' }]);
    assert.equal(requests.length, 1, 'an interrupted stream is not automatically replayed');
  });
});

test('an SSE partial frame at EOF fails and does not trigger a new request', async () => {
  await withEndpoint((_attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start"');
  }, async (baseUrl, requests) => {
    await assert.rejects(
      () => collect(provider(baseUrl).stream({})),
      (error) => error.code === 'provider_stream_incomplete',
    );
    assert.equal(requests.length, 1);
  });
});

test('a clean HTTP EOF without the provider stop event is not a successful turn', async () => {
  await withEndpoint((_attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{}}}\n\n');
  }, async (baseUrl, requests) => {
    await assert.rejects(
      () => collect(provider(baseUrl).stream({})),
      (error) => error.code === 'provider_stream_incomplete',
    );
    assert.equal(requests.length, 1, 'a malformed successful-status stream is not retried');
  });
});

test('abort during retry backoff returns promptly without an extra request', async (t) => {
  await withEndpoint((_attempt, response) => {
    response.writeHead(503);
    response.end('retry later');
  }, async (baseUrl, requests) => {
    const controller = new AbortController();
    const started = performance.now();
    const pending = collect(provider(baseUrl, { ...FAST_RETRY, baseDelayMs: 10_000 }).stream({}, { signal: controller.signal }));
    while (requests.length === 0) await delay(1);
    controller.abort();
    await assert.rejects(pending, (error) => error.code === 'provider_cancelled');
    const elapsedMs = performance.now() - started;
    assert.equal(requests.length, 1, 'backoff cancellation prevents the next attempt');
    assert.ok(elapsedMs < 1_000, `cancelled backoff took ${elapsedMs.toFixed(1)}ms`);
    t.diagnostic(`actualRequests=${requests.length}; cancellationElapsedMs=${elapsedMs.toFixed(1)}; errorCode=provider_cancelled`);
  });
});

test('abort during an active SSE read closes the HTTP response without another request', async () => {
  await withEndpoint((_attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{}}}\n\n');
    response.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
    response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"started"}}\n\n');
    response.flushHeaders();
  }, async (baseUrl, requests) => {
    const controller = new AbortController();
    const iterator = provider(baseUrl).stream({}, { signal: controller.signal });
    assert.deepEqual(await iterator.next(), { done: false, value: { type: 'text', text: 'started' } });
    controller.abort();
    await assert.rejects(() => iterator.next(), (error) => error.code === 'provider_cancelled');
    assert.equal(requests.length, 1, 'an active SSE cancellation never opens a second request');
    await Promise.race([
      requests[0].responseClosed,
      delay(1_000).then(() => { throw new Error('the cancelled HTTP response remained open'); }),
    ]);
  });
});
