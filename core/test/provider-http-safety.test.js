import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { open, parseSse, DEFAULT_RETRY } from '../dist/model/http.js';
import { listenFetchable } from './helpers/port.js';

const SENTINEL = 'PLAN2_SYNTHETIC_PRIVATE_SENTINEL_NEVER_LOG';
const RETRY = { ...DEFAULT_RETRY, maxAttempts: 1, baseDelayMs: 1 };

async function endpoint(respond, run) {
  const server = createServer(respond);
  const url = `http://127.0.0.1:${await listenFetchable(server)}`;
  try { await run(url); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function safeFailure(code) {
  return (error) => {
    assert.equal(error.code, code);
    assert.equal((String(error.detail) + String(error.cause) + error.stack).includes(SENTINEL), false);
    return true;
  };
}

test('Provider HTTP failure does not expose an upstream response body', async () => {
  await endpoint((request, response) => {
    response.writeHead(401);
    response.end(`invalid authorization: ${SENTINEL}`);
  }, async (url) => {
    await assert.rejects(open(url, { method: 'POST' }, RETRY), safeFailure('provider_http_error'));
  });
});

test('Malformed SSE JSON does not expose response text through details or causes', async () => {
  await endpoint((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${SENTINEL}\n\n`);
  }, async (url) => {
    const response = await open(url, { method: 'POST' }, RETRY);
    await assert.rejects(async () => {
      for await (const event of parseSse(response.body)) assert.fail(`unexpected event ${typeof event}`);
    }, safeFailure('provider_stream_invalid'));
  });
});

test('context overflow remains recognizable without disclosing the upstream diagnostic', async () => {
  await endpoint((request, response) => {
    response.writeHead(400);
    response.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: SENTINEL } }));
  }, async (url) => {
    await assert.rejects(open(url, { method: 'POST' }, RETRY), (error) => {
      safeFailure('provider_http_error')(error);
      assert.equal(error.detail, 'HTTP 400 context_length_exceeded');
      return true;
    });
  });
});
