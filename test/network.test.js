// 第 27 步的验收（D48、D58）：地址分类、判定链那一层的收紧、批准与连接绑在同一次解析上、逐跳重判、超时与字节上限。
// 服务器是真的（本机环回上一个 http.Server），内核与判定链走的是同一条调用路径；
// 只有 DNS 那一步换成一张固定的表——要判的是分类与「连的是批准过的那个地址」，不是运营商今天给哪一个 IP。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyAddress, createConfig, createDecisionChain, createKernel, createSessionLog, fetchTarget,
  loadAssembly, minimalPlugin, networkPlugin, resolveTarget,
} from '../dist/index.js';

const listening = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${server.address().port}`, port: String(server.address().port) }));
});
const limits = { maxBytes: 1_000, timeoutMs: 2_000, redirectLimit: 5 };
const fromTable = (table) => async (host) => {
  if (!(host in table)) throw new Error(`unexpected lookup for ${host}`);
  return table[host];
};

test('addresses are classified by their bytes, including the forms a URL normalizes into', () => {
  assert.equal(classifyAddress('127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('128.0.0.1'), 'public');
  assert.equal(classifyAddress('10.1.2.3'), 'private');
  assert.equal(classifyAddress('172.16.0.1'), 'private');
  assert.equal(classifyAddress('172.15.255.255'), 'public');
  assert.equal(classifyAddress('192.168.7.7'), 'private');
  assert.equal(classifyAddress('100.64.0.9'), 'private');
  assert.equal(classifyAddress('100.128.0.1'), 'public');
  assert.equal(classifyAddress('169.254.169.254'), 'link-local');
  // 未指定、组播与保留段不按公网算。
  assert.equal(classifyAddress('0.0.0.0'), 'unspecified');
  assert.equal(classifyAddress('224.0.0.1'), 'unspecified');
  assert.equal(classifyAddress('255.255.255.255'), 'unspecified');
  assert.equal(classifyAddress('8.8.8.8'), 'public');
  assert.equal(classifyAddress('::1'), 'loopback');
  assert.equal(classifyAddress('::'), 'unspecified');
  assert.equal(classifyAddress('fd12:3456::1'), 'private');
  assert.equal(classifyAddress('fe80::1'), 'link-local');
  assert.equal(classifyAddress('ff02::1'), 'unspecified');
  assert.equal(classifyAddress('2606:4700:4700::1111'), 'public');
  // 同一条 IPv4 映射地址的两种写法必须给出同一个结果：URL 会把点分那一种规范化成十六进制那一种。
  assert.equal(classifyAddress('::ffff:127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('::ffff:7f00:1'), 'loopback');
  assert.equal(classifyAddress('::ffff:9301:d222'), 'public');
  assert.equal(classifyAddress('::1:2:3:4:5'), 'public');
  assert.equal(classifyAddress('gg::1'), 'unspecified');
  assert.equal(classifyAddress('1.2.3'), 'unspecified');
});

test('a target is one URL, one resolution, and the strictest address decides', async () => {
  const resolve = fromTable({ 'mix.es': ['93.184.216.34', '10.0.0.5'], 'pu.blic': ['93.184.216.34'], 'bad.host': [] });
  assert.equal((await resolveTarget('http://mix.es/x', { resolve })).class, 'private');
  assert.equal((await resolveTarget('https://pu.blic/', { resolve })).class, 'public');
  assert.equal((await resolveTarget('http://bad.host/', { resolve })).failure, 'unresolved');
  assert.equal((await resolveTarget('file:///etc/passwd')).failure, 'unsupported');
  assert.equal((await resolveTarget('http://user:pw@host/')).failure, 'unsupported');
  assert.equal((await resolveTarget('')).failure, 'unsupported');
  assert.equal((await resolveTarget('not a url')).failure, 'unsupported');
  // 字面量地址不经 DNS；带方括号的那种被 URL 规范化之后仍按 IPv4 映射判。
  assert.equal((await resolveTarget('http://localhost:5368/')).class, 'loopback');
  assert.equal((await resolveTarget('http://[::ffff:127.0.0.1]:8080/x')).class, 'loopback');
  assert.deepEqual((await resolveTarget('http://10.0.0.7/x')).addresses, ['10.0.0.7']);
});

test('the chain tightens on the class before any rule is consulted', async () => {
  const asked = [];
  const chain = (answer) => createDecisionChain({
    mode: 'auto',
    ask: async (question) => {
      asked.push(question);
      return answer;
    },
    rules: [{ tool: 'fetch', decision: 'allow' }],
  });

  // 自动档也不把环回与内网直接放行：那条 URL 指的是本机上的服务，规则表写得再宽也不算盖住。
  const loop = await chain(true).evaluate({ tool: 'fetch', input: {}, target: await resolveTarget('http://127.0.0.1:8080/') });
  assert.deepEqual(loop, { decision: 'allow', capability: 'fetch', via: 'ask', level: 'auto', answer: 'allow' });
  assert.equal(asked.length, 1);
  assert.match(asked[0].reason, /loopback/);
  assert.equal((await chain(false).evaluate({ tool: 'fetch', input: {}, target: await resolveTarget('http://10.0.0.5/x') })).code, 'ask_declined');

  // 链路本地与「根本不该被取回的地址」不进询问：没有可问的余地。
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[ff02::1]/', 'http://0.0.0.0/']) {
    const before = asked.length;
    const denied = await chain(true).evaluate({ tool: 'fetch', input: {}, target: await resolveTarget(url) });
    assert.equal(denied.code, 'policy_denied', url);
    assert.equal(asked.length, before, `${url} did not ask`);
  }
  assert.equal((await chain(true).evaluate({ tool: 'fetch', input: {}, target: await resolveTarget('ftp://host/x') })).code, 'policy_denied');
  // 公网目标在自动档里照原来的顺序走：这一件工具没有命令文本可解析。
  assert.deepEqual(await chain(true).evaluate({ tool: 'fetch', input: {}, target: await resolveTarget('http://93.184.216.34/') }), { decision: 'allow', capability: 'fetch', via: 'auto', level: 'auto' });
});

test('the socket uses the address the target resolved to while the name stays in the request', async () => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ host: request.headers.host, url: request.url });
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('the page');
  });
  const { port } = await listening(server);
  const looked = [];
  const resolve = async (host) => {
    looked.push(host);
    return ['127.0.0.1'];
  };
  try {
    // 名字指向环回：批准是对这一个 IP 给的，连接也就不再去问第二次 DNS。
    const target = await resolveTarget(`http://approved.invalid:${port}/note`, { resolve });
    const page = await fetchTarget(target, { ...limits, resolve });
    assert.equal(page.text, 'the page');
    assert.deepEqual(seen, [{ host: `approved.invalid:${port}`, url: '/note' }]);
    assert.deepEqual(looked, ['approved.invalid'], 'one resolution for one request');
    assert.equal(target.class, 'loopback');
  } finally {
    server.close();
  }
});

test('fetch is asked about a loopback page and records what arrived', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(request.url === '/big' ? 'x'.repeat(5_000) : 'the page');
  });
  const { origin } = await listening(server);
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
    assert.equal(result.targetClass, 'loopback');
    assert.equal(result.bytes, 8);
    assert.equal(result.hops, 0);
    assert.equal(asked.length, 1, 'the loopback target was asked about even in the automatic level');
    assert.match(asked[0].reason, /loopback/);

    const capped = await kernel.call('fetch', { url: `${origin}/big` });
    assert.ok(capped.text.startsWith('x'.repeat(1_000)));
    assert.match(capped.text, /\[truncated: 1000 of 5000 bytes shown]/);
    assert.equal(capped.bytes, 5_000);
    assert.equal(capped.truncated, true);

    // 判定链在的话根本不会问到工具这里；没有链的那一条入口（`ligule call`）由工具自己守住这条边界。
    const metadata = await kernel.call('fetch', { url: 'http://169.254.169.254/latest/meta-data/' }).catch((error) => error);
    assert.equal(metadata.code, 'policy_denied');
    assert.equal(asked.length, 2, 'the denial did not add a question');
    const chainless = createKernel({ config: createConfig({ user: { boundary: process.cwd() } }) });
    loadAssembly(chainless, [minimalPlugin, networkPlugin]);
    const refused = await chainless.call('fetch', { url: 'http://169.254.169.254/latest/meta-data/' }).catch((error) => error);
    assert.equal(refused.code, 'fetch_target_denied');
  } finally {
    server.close();
  }
});

test('a redirect must be the same origin and the same class, re-resolved', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/same-origin') {
      response.writeHead(302, { location: '/final' });
      response.end();
      return;
    }
    if (request.url === '/final') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('landed');
      return;
    }
    if (request.url === '/cross-origin') {
      response.writeHead(302, { location: 'http://example.com:1/final' });
      response.end();
      return;
    }
    if (request.url === '/rebinds') {
      response.writeHead(302, { location: '/final' });
      response.end();
      return;
    }
    response.writeHead(500);
    response.end('nope');
  });
  const { origin, port } = await listening(server);
  try {
    const same = await fetchTarget(await resolveTarget(`${origin}/same-origin`), limits);
    assert.equal(same.text, 'landed');
    assert.equal(same.hops, 1);

    // 换了主机就不是那一次批准覆盖的目标：同源之内才继续跟。
    const cross = await fetchTarget(await resolveTarget(`${origin}/cross-origin`), limits).catch((error) => error);
    assert.equal(cross.code, 'fetch_redirect_denied');
    assert.match(cross.detail, /another origin/);

    // 同一个名字，第二跳解析到别的类别也算换了目标：每一跳都重新解析一次。
    let looked = 0;
    const flipping = async () => {
      looked += 1;
      return looked === 1 ? ['127.0.0.1'] : ['10.0.0.5'];
    };
    const flippingTarget = await resolveTarget(`http://flips.invalid:${port}/rebinds`, { resolve: flipping });
    const rebound = await fetchTarget(flippingTarget, { ...limits, resolve: flipping }).catch((error) => error);
    assert.equal(rebound.code, 'fetch_redirect_denied');
    assert.match(rebound.detail, /private/);
    assert.equal(looked, 2, 'the hop was resolved again instead of reused');

    const failed = await fetchTarget(await resolveTarget(`${origin}/gone`), limits).catch((error) => error);
    assert.equal(failed.code, 'fetch_response_failed');
  } finally {
    server.close();
  }
});

test('a page that never answers is stopped by the timeout', async () => {
  const server = createServer(() => {
    // 故意不回：这一条要由超时收掉。
  });
  const { origin } = await listening(server);
  try {
    const error = await fetchTarget(await resolveTarget(`${origin}/slow`), { ...limits, timeoutMs: 60 }).catch((failure) => failure);
    assert.equal(error.code, 'fetch_transport_failed');
    assert.match(error.detail, /no answer within 60ms/);
  } finally {
    server.close();
  }
});

test('the session record shows which host and which addresses were fetched', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('hello from the note');
  });
  const { origin } = await listening(server);
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
    // 记录里看得见取了哪一个域名、实际字节数与按哪一类地址放行（D58）。
    assert.equal(events[0].result.content.host, '127.0.0.1');
    assert.deepEqual(events[0].result.content.addresses, ['127.0.0.1']);
    assert.equal(events[0].result.content.bytes, 19);
    assert.match(await readFile(join(root, 'one.jsonl'), 'utf8'), /"targetClass":"loopback"/);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
