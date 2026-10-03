// 第 27 步的验收（D48、D58）：地址分类、判定链那一层的收紧、逐跳重判、超时与字节上限。
// 服务器是真的（本机环回上一个 http.Server），内核与判定链走的是同一条调用路径；
// 只有 DNS 那一步换成一张固定的表，因为要判的是分类逻辑而不是运营商今天给哪一个地址。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyAddress, classifyTarget, createConfig, createDecisionChain, createKernel, createSessionLog,
  fetchTarget, loadAssembly, minimalPlugin, networkPlugin,
} from '../dist/index.js';

const listening = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});

const target = (url) => classifyTarget(url);

test('addresses are classified by what they are, not by how the URL looks', () => {
  assert.equal(classifyAddress('127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('128.0.0.1'), 'public');
  assert.equal(classifyAddress('10.1.2.3'), 'private');
  assert.equal(classifyAddress('172.16.0.1'), 'private');
  assert.equal(classifyAddress('172.15.255.255'), 'public');
  assert.equal(classifyAddress('192.168.7.7'), 'private');
  assert.equal(classifyAddress('100.64.0.9'), 'private');
  assert.equal(classifyAddress('100.128.0.1'), 'public');
  assert.equal(classifyAddress('169.254.169.254'), 'link-local');
  assert.equal(classifyAddress('8.8.8.8'), 'public');
  assert.equal(classifyAddress('::1'), 'loopback');
  assert.equal(classifyAddress('::ffff:127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('fd12:3456::1'), 'private');
  assert.equal(classifyAddress('fe80::1'), 'link-local');
  assert.equal(classifyAddress('2606:4700:4700::1111'), 'public');
});

test('a name is classified by the strictest address it resolves to', async () => {
  const resolve = async (host) => ({ 'mix.es': ['93.184.216.34', '10.0.0.5'], 'pu.blic': ['93.184.216.34'], 'bad.host': [] }[host]);
  assert.equal((await classifyTarget('http://mix.es/x', { resolve })).class, 'private');
  assert.equal((await classifyTarget('https://pu.blic/', { resolve })).class, 'public');
  // 解析不出地址不算「按公网放行」：说清楚是没解析出来。
  assert.equal((await classifyTarget('http://bad.host/', { resolve })).failure, 'unresolved');
  assert.equal((await classifyTarget('file:///etc/passwd')).failure, 'unsupported');
  assert.equal((await classifyTarget('http://localhost:5368/')).class, 'loopback');
});

test('the chain tightens on the class before any rule is consulted', async () => {
  const asked = [];
  const chain = (options) => createDecisionChain({
    ...options,
    ask: async (question) => {
      asked.push(question);
      return options.answer;
    },
    rules: [{ tool: 'fetch', decision: 'allow' }],
  });

  // 自动档也不把环回与内网直接放行：那条 URL 指的是本机上的服务，规则表写得再宽也不算盖住。
  const loop = await chain({ mode: 'auto', answer: true }).evaluate({ tool: 'fetch', input: {}, target: await target('http://127.0.0.1:8080/') });
  assert.deepEqual(loop, { decision: 'allow' });
  assert.equal(asked.length, 1);
  assert.match(asked[0].reason, /loopback/);

  const refused = await chain({ mode: 'auto', answer: false }).evaluate({ tool: 'fetch', input: {}, target: await target('http://10.0.0.5/x') });
  assert.equal(refused.code, 'ask_declined');

  // 链路本地那一类（含云主机的元数据端点）不进询问：没有可问的余地。
  const askedBefore = asked.length;
  const denied = await chain({ mode: 'ask', answer: true }).evaluate({ tool: 'fetch', input: {}, target: await target('http://169.254.169.254/latest/meta-data/') });
  assert.equal(denied.code, 'policy_denied');
  assert.match(denied.reason, /link-local/);
  assert.equal(asked.length, askedBefore, 'a denial did not ask');

  assert.equal((await chain({ mode: 'auto', answer: true }).evaluate({ tool: 'fetch', input: {}, target: await target('ftp://host/x') })).code, 'policy_denied');
  // 公网目标在自动档里照原来的顺序走：这一件工具没有命令文本可解析。
  assert.deepEqual(await chain({ mode: 'auto', answer: true }).evaluate({ tool: 'fetch', input: {}, target: await target('http://93.184.216.34/') }), { decision: 'allow' });
});

test('fetch asks about a loopback page and records host and bytes', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(request.url === '/big' ? 'x'.repeat(5_000) : 'the page');
  });
  const origin = await listening(server);
  const asked = [];
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd(), limits: { fetchBytes: 1_000 } } }),
    policy: createDecisionChain({ mode: 'auto', ask: async (question) => (asked.push(question), true) }),
  });
  loadAssembly(kernel, [minimalPlugin, networkPlugin]);
  try {
    const result = await kernel.call('fetch', { url: `${origin}/note` });
    assert.equal(result.text, 'the page');
    assert.equal(result.host, '127.0.0.1');
    assert.equal(result.bytes, 8);
    assert.equal(result.hops, 0);
    assert.equal(asked.length, 1, 'the loopback target was asked about even in the automatic level');
    assert.match(asked[0].reason, /loopback/);

    const capped = await kernel.call('fetch', { url: `${origin}/big` });
    assert.ok(capped.text.startsWith('x'.repeat(1_000)));
    assert.match(capped.text, /\[truncated: 1000 of 5000 bytes shown]/);
    assert.equal(capped.bytes, 5_000);
    assert.equal(capped.truncated, true);

    // 元数据端点连问都不问：这一条调用在判定链就被拦下，请求没发出去。
    const metadata = await kernel.call('fetch', { url: 'http://169.254.169.254/latest/meta-data/' }).catch((error) => error);
    assert.equal(metadata.code, 'policy_denied');
    assert.equal(asked.length, 2, 'the denial did not add a question');
  } finally {
    server.close();
  }
});

test('a redirect may not move the request into another class', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/to-public') {
      response.writeHead(302, { location: 'http://93.184.216.34/page' });
      response.end();
      return;
    }
    if (request.url === '/to-metadata') {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      response.end();
      return;
    }
    response.writeHead(500);
    response.end('nope');
  });
  const origin = await listening(server);
  const limits = { maxBytes: 1_000, timeoutMs: 2_000, redirectLimit: 5 };
  try {
    // 批准是对环回给的，跳到公网地址就不跟：那一次「允许」没覆盖另一个地址。
    const out = await fetchTarget(`${origin}/to-public`, limits).catch((error) => error);
    assert.equal(out.code, 'fetch_redirect_denied');
    assert.match(out.detail, /93\.184\.216\.34/);
    const metadata = await fetchTarget(`${origin}/to-metadata`, limits).catch((error) => error);
    assert.equal(metadata.code, 'fetch_redirect_denied');
    assert.match(metadata.detail, /link-local/);
    // 一个非 2xx 的答复不是「拿到了一页」：报出去而不是交回一段空文本。
    const failed = await fetchTarget(`${origin}/gone`, limits).catch((error) => error);
    assert.equal(failed.code, 'fetch_response_failed');
  } finally {
    server.close();
  }
});

test('a page that never answers is stopped by the timeout', async () => {
  const server = createServer(() => {
    // 故意不回：这一条要由超时收掉。
  });
  const origin = await listening(server);
  try {
    const error = await fetchTarget(`${origin}/slow`, { maxBytes: 1_000, timeoutMs: 250, redirectLimit: 5 }).catch((failure) => failure);
    assert.equal(error.code, 'fetch_transport_failed');
    assert.match(error.detail, /no answer within 250ms/);
  } finally {
    server.close();
  }
});

test('the session record shows which host was fetched and how much arrived', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('hello from the note');
  });
  const origin = await listening(server);
  const root = await mkdtemp(join(tmpdir(), 'ligule-fetch-record-'));
  const session = createSessionLog({ directory: root, id: 'one' });
  const kernel = createKernel({ config: createConfig({ user: { boundary: process.cwd() } }), session });
  loadAssembly(kernel, [minimalPlugin, networkPlugin]);
  try {
    await kernel.call('fetch', { url: `${origin}/note` });
    const events = await session.read();
    assert.deepEqual(events.map((event) => event.kind), ['tool']);
    assert.equal(events[0].tool, 'fetch');
    assert.equal(events[0].result.content.text, 'hello from the note');
    // 记录里看得见取了哪一个域名与实际字节数（D58）。
    assert.equal(events[0].result.content.host, '127.0.0.1');
    assert.equal(events[0].result.content.bytes, 19);
    assert.match(await readFile(join(root, 'one.jsonl'), 'utf8'), /"host":"127\.0\.0\.1"/);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
