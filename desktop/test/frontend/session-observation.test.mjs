import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfig, createConnection, createMemoryConnectionPair, MESSAGES_CAPABILITIES, serveHost } from '../../../core/dist/index.js';
import { observeExternalSession } from '../../frontend/src/external-session-observation.ts';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('polls a real Host observation, ignores stale snapshots, and stops after disposal', async () => {
  const testRoot = join(repositoryRoot, 'desktop', 'testplace', 'tmp');
  const projectRoot = join(testRoot, `session-observation-${process.pid}-${Date.now()}`);
  await mkdir(projectRoot, { recursive: true });
  const config = createConfig({
    user: {
      boundary: projectRoot,
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
      policy: { mode: 'auto' },
    },
  });
  const provider = {
    capabilities: MESSAGES_CAPABILITIES,
    model: 'test-model',
    async *stream() { yield { type: 'text', text: 'unused' }; },
  };
  const pair = createMemoryConnectionPair();
  const host = serveHost({ ...pair.host, config, provider, policy: config.policy });
  const connection = createConnection(pair.client);
  const client = { call: (method, params, timeoutMs) => connection.request(method, params, timeoutMs) };
  let stop;
  let stopStale;
  let timeout;
  let responseTimeout;
  let observedCount = 0;
  try {
    const { sessionId } = await client.call('session.create', {});
    const directSnapshot = await client.call('session.observe', { projectRoot, sessionId, limit: 400, fullResults: true });
    assert.ok(Array.isArray(directSnapshot.events));
    const firstSnapshot = new Promise((resolveSnapshot, reject) => {
      timeout = setTimeout(() => reject(new Error('session_observation_timeout')), 5_000);
      stop = observeExternalSession({
        client,
        projectRoot,
        sessionId,
        limit: 400,
        isCurrent: () => true,
        onSnapshot: (snapshot) => { observedCount += 1; resolveSnapshot(snapshot); },
      });
    });
    const snapshot = await firstSnapshot;
    clearTimeout(timeout);
    assert.ok(Array.isArray(snapshot.events));
    assert.equal(typeof snapshot.writerActive, 'boolean');
    assert.equal(observedCount, 1);

    stop();
    await delay(1_100);
    assert.equal(observedCount, 1, 'disposed observers stop their polling timer');

    let releaseResponse;
    let responseReady;
    const responseGate = new Promise((resolveResponse) => { releaseResponse = resolveResponse; });
    const hostResponse = new Promise((resolveResponse) => { responseReady = resolveResponse; });
    const delayedClient = {
      call: async (...args) => {
        const result = await client.call(...args);
        responseReady();
        await responseGate;
        return result;
      },
    };
    let current = true;
    let staleCount = 0;
    stopStale = observeExternalSession({
      client: delayedClient,
      projectRoot,
      sessionId,
      limit: 400,
      isCurrent: () => current,
      onSnapshot: () => { staleCount += 1; },
    });
    await Promise.race([hostResponse, new Promise((resolveResponse, reject) => {
      responseTimeout = setTimeout(() => reject(new Error('stale_host_response_timeout')), 5_000);
    })]);
    clearTimeout(responseTimeout);
    current = false;
    releaseResponse();
    await delay(50);
    stopStale();
    stopStale = undefined;
    assert.equal(staleCount, 0, 'late Host snapshots are ignored after the session changes');
  } finally {
    clearTimeout(timeout);
    clearTimeout(responseTimeout);
    stop?.();
    stopStale?.();
    pair.client.output.end();
    await host.release();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
