// 第 14 步的验收：一个子进程经标准输入输出上的这条协议跑完一轮（D30），全程不开端口。
// 模型那一侧是本地起的真实 HTTP 服务按 SSE 一帧一帧写出去，与 test/provider.test.js 同一种测法；
// 进程、流、审批往返回与落盘的记录都是真的，没有假实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createConnection, createConfig, createMemoryConnectionPair, MESSAGES_CAPABILITIES, METHODS, NOTIFICATIONS, providerFromConfig, resolveShell, serveHost } from '../dist/index.js';
import { shownConfigOf } from '../dist/host/host.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const TOOL_TURN = [
  { type: 'message_start', message: { usage: {} } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'read' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path": "note.txt"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_stop' },
];

const TEXT_TURN = [
  { type: 'message_start', message: { usage: {} } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the file says so' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_stop' },
];

// 本地那一个模型端点：请求里带工具结果就答文本，否则答一次 read 调用。交回的 requests 是按次序记下来的请求体。
async function withEndpoint(run) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const events = JSON.stringify(body.messages).includes('tool_result') ? TEXT_TURN : TOOL_TURN;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

// 起一个 Host 子进程，并在它的标准输入输出两端装好这条协议的客户端。
// --config 的值是一段 TOML，所以字符串要带引号（D8 那一条装载规则）。
// HOME 与 USERPROFILE 指到这个临时目录：命令行为读真实主目录下的用户层配置，那一份属于这台机器，
// 它写了 `model.apiKeyEnv` 就会盖掉这里设的 `LIGULE_API_KEY`，本机配了什么测试就跟着变红。
function startHost(directory, baseUrl) {
  const child = spawn(process.execPath, [
    CLI, 'host',
    '--config', 'model.api="messages"',
    '--config', `model.baseURL="${baseUrl}"`,
    '--config', 'model.model="test-model"',
    '--config', 'policy.mode="ask"',
  ], { cwd: directory, env: { ...process.env, HOME: directory, USERPROFILE: directory, LIGULE_API_KEY: 'test-key' } });
  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  return {
    child,
    stderr,
    client: createConnection({ input: child.stdout, output: child.stdin }),
  };
}

// 一轮跑完之后再关本地服务与子进程：模型那两次请求都要打在还开着的服务上。
async function withHost(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-host-'));
  await writeFile(join(directory, 'note.txt'), 'the body');
  try {
    return await withEndpoint(async (baseUrl) => {
      const host = startHost(directory, baseUrl);
      const notifications = [];
      const approvals = [];
      host.client.onNotification((message) => notifications.push(message));
      try {
        return await run(host, { notifications, approvals, directory, baseUrl, startAnother: () => startHost(directory, baseUrl) });
      } finally {
        await stop(host);
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// 退出信号已经发过了就别再等 'exit'，它不会再响一次；自己退出去而码不是 0 时，把子进程说过的那一段带出来。
async function stop(host) {
  if (host.child.exitCode === null && host.child.signalCode === null) {
    host.child.kill();
    await new Promise((resolve) => host.child.on('exit', resolve));
  }
  if (host.child.exitCode !== 0 && host.child.signalCode !== 'SIGTERM') {
    throw new Error(`the Host exited with ${host.child.exitCode}: ${host.stderr.join('')}`);
  }
}

// 等一件已经在别处发生的事：跨进程的这一侧看不见对面的内部时刻，只能看它写过来的东西。
async function waitFor(what, done) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (done()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('a client over stdio drives one round, answers one approval and watches the events arrive', async () => {
  await withHost(async (host, { notifications, approvals, directory }) => {
    host.client.onRequest(async (message) => {
      approvals.push(message.params);
      return { decision: 'allow' };
    });
    const { sessionId } = await host.client.request('session.create', {});
    const result = await host.client.request('run.start', { sessionId, input: 'read the note' });

    assert.equal(result.text, 'the file says so');
    assert.equal(result.iterations, 2);
    // 审批是 Host 发出去、客户端答复的一次请求，工具名与参数都在里面。
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].tool, 'read');
    assert.deepEqual(approvals[0].args, { path: 'note.txt' });
    assert.equal(approvals[0].sessionId, sessionId);
    // 没有命令文本的调用不带后端那两样：那一种语法与哪一个可执行文件对读一次文件这件事没有意义。
    assert.equal(approvals[0].shell, undefined);
    assert.equal(approvals[0].executable, undefined);

    const deltas = notifications.filter((message) => message.notify === 'delta').map((message) => message.event);
    assert.deepEqual(deltas.map((event) => event.type), ['tool-call', 'text'], 'the stream is forwarded as it arrives');
    assert.ok(notifications.every((message) => NOTIFICATIONS.includes(message.notify)), 'nothing arrives outside the names the protocol declares');
    const events = notifications.filter((message) => message.notify === 'event').map((message) => message.event);
    // 装载先记一条模式事件：那一份清单是这一轮工具栏目的来源（I2、I5）。
    // 最后那一条是轮次完成标记：它跟在助手那一条之后，不进投影（实现顺序第 68 步）。
    assert.deepEqual(events.map((event) => event.kind), ['mode', 'user', 'assistant', 'tool', 'assistant', 'turn']);
    assert.equal(events.find((event) => event.kind === 'tool').result.content.text, 'the body', 'the tool result the client saw is the file content');

    // 客户端看见的那一条与记录里落盘的那一条同源，序号也在通知里带回来了。
    const lines = (await readFile(join(directory, '.ligule', 'sessions', `${sessionId}.jsonl`), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    // 首行是会话元信息，不是一条事件；宿主先读一遍（模式去重）也该把它写出来（D73）。
    assert.equal(lines[0].kind, 'session');
    assert.equal(lines[0].sessionId, sessionId);
    const recorded = lines.slice(1);
    assert.deepEqual(recorded.map((event) => event.seq), events.map((event) => event.seq));
    assert.match(recorded[0].digest, /^[0-9a-f]{12}$/, '模式事件带着那一份清单的摘要，恢复时比的就是它（D78）');

    const status = await host.client.request('status.get', { sessionId });
    assert.equal(status.running, false);
    assert.equal(status.policy, 'ask');
    assert.equal(status.mode, 'minimal', '状态里模式名与判定档位是两样东西（D40）');
    assert.ok(status.tools.includes('read'));
    assert.deepEqual(status.denials, { consecutive: 0, total: 0 });
    // 提示模板的名字与说明交出去，界面才列得出来；展开仍然只在宿主做那一次（D24、D81）。
    assert.ok(Array.isArray(status.templates), 'status carries the prompt templates the host loaded');
  });
});

test('cancelling while an approval is open stops the round instead of leaving it unanswered', async () => {
  await withHost(async (host, { approvals }) => {
    // 这一次不答复：取消落在一桩还没回答的审批上，等它的那一次要收回来。
    host.client.onRequest(async (message) => {
      approvals.push(message.params);
      return new Promise(() => {});
    });
    const { sessionId } = await host.client.request('session.create', {});
    const running = host.client.request('run.start', { sessionId, input: 'read the note' });
    await waitFor('the approval to reach the client', () => approvals.length > 0);
    assert.equal(approvals.length, 1, 'the approval reached the client before the cancel');
    assert.deepEqual(await host.client.request('run.cancel', { sessionId }), { cancelled: true });
    await assert.rejects(running, (error) => error.code === 'loop_cancelled');
    // 记录里那一次调用有结果顶着：审批被收回之后按不允许处理，而不是留下一个没人回答的调用。
    const status = await host.client.request('status.get', { sessionId });
    assert.equal(status.running, false);
    assert.deepEqual(status.denials, { consecutive: 1, total: 1 });
  });
});

test('closing the pipe in the middle of a round ends the Host process without a crash', async () => {
  await withHost(async (host, { approvals }) => {
    // 记下这一问但不答复，让这一轮跑在没人接手的地方，然后客户端走掉。
    host.client.onRequest(async (message) => {
      approvals.push(message.params);
      return new Promise(() => {});
    });
    const { sessionId } = await host.client.request('session.create', {});
    host.client.request('run.start', { sessionId, input: 'read the note' }).catch(() => {});
    await waitFor('the approval to reach the client', () => approvals.length > 0);

    host.child.stdin.end();
    const code = await Promise.race([
      new Promise((resolve) => host.child.on('exit', resolve)),
      delay(10000, undefined, { ref: false }).then(() => {
        host.child.kill();
        return null;
      }),
    ]);
    // 取消落下来之后还有一条要给对端的答复：管道没了就丢掉，不该把进程自己弄崩。
    assert.equal(code, 0, `the Host exited with ${code}`);
  });
});

test('a second Host process opens the same record, so the session lives in the Host and not in a client', async () => {
  await withHost(async (host, { directory, startAnother }) => {
    host.client.onRequest(async () => ({ decision: 'allow' }));
    const { sessionId } = await host.client.request('session.create', {});
    await host.client.request('run.start', { sessionId, input: 'read the note' });
    const path = join(directory, '.ligule', 'sessions', `${sessionId}.jsonl`);
    const before = await readFile(path, 'utf8');

    // 界面这一侧把管道关掉：Host 自己收掉还在跑的那一轮并撤掉插件，然后退出，不需要谁去终止它。
    host.child.stdin.end();
    const exited = await Promise.race([
      new Promise((resolve) => host.child.on('exit', (code, signal) => resolve({ code, signal }))),
      delay(5000, undefined, { ref: false }).then(() => ({ code: null, signal: null })),
    ]);
    assert.deepEqual(exited, { code: 0, signal: null }, 'closing the pipe ends the Host process by itself');

    const second = startAnother();
    try {
      second.client.onRequest(async () => ({ decision: 'deny' }));
      assert.deepEqual(await second.client.request('session.open', { sessionId }), { sessionId });
      // 晚到的客户端把已经发生过的事读回来：记录是唯一事实源（I5），这一份与第一个进程写下的相同。
      const reopened = await second.client.request('session.read', { sessionId });
      assert.equal(reopened.sessionId, sessionId);
      // 第二个进程装载同一份清单，不再往记录里补一条：attach 与读不动事实源（I5）。
      assert.deepEqual(reopened.events.map((event) => event.kind), ['mode', 'user', 'assistant', 'tool', 'assistant', 'turn']);
      assert.equal(reopened.events.find((event) => event.kind === 'tool').result.content.text, 'the body');
      const status = await second.client.request('status.get', { sessionId });
      assert.equal(status.running, false);
      assert.equal(status.eventCount, reopened.events.length);
      assert.ok(status.tools.includes('read'), 'the new process installs the same manifest');
    } finally {
      await stop(second);
    }
    assert.equal(await readFile(path, 'utf8'), before, 'attaching and reading changed nothing in the record');
  });
});

// 在终端上答复这一问：提示一出来就写一行答复；answer 给 null 就一行都不写、直接把管道关掉，
// 那一次问就没有人答复，按不允许处理。
async function runCli(directory, answer) {
  return withEndpoint(async (baseUrl, requests) => {
    const child = spawn(process.execPath, [
      CLI, 'run', 'read the note',
      '--config', 'model.api="messages"',
      '--config', `model.baseURL="${baseUrl}"`,
      '--config', 'model.model="test-model"',
      '--config', 'policy.mode="ask"',
    ], { cwd: directory, env: { ...process.env, HOME: directory, USERPROFILE: directory, LIGULE_API_KEY: 'test-key' } });
    const written = { stdout: '', stderr: '' };
    // 只答一次：提示里那段字样在之后的每一个数据块上都还在，不记这一次就会对着已经关掉的管道再写一遍。
    let answered = false;
    for (const name of ['stdout', 'stderr']) {
      child[name].setEncoding('utf8');
      child[name].on('data', (chunk) => {
        written[name] += chunk;
        if (!answered && written.stderr.includes('[y/N]')) {
          answered = true;
          if (answer !== null) child.stdin.write(`${answer}\n`);
          child.stdin.end();
        }
      });
    }
    // 子进程不退出就是它卡住了，别让整个测试跟着等下去。
    const code = await Promise.race([
      new Promise((resolve) => child.on('exit', resolve)),
      delay(20000, undefined, { ref: false }).then(() => {
        child.kill();
        return null;
      }),
    ]);
    return { code, requests, ...written };
  });
}

test('ligule run prints the round, asks the terminal once, and the project instructions reach the request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-run-'));
  await writeFile(join(directory, 'note.txt'), 'the body');
  await writeFile(join(directory, 'AGENTS.md'), '# 项目规则\nprint nothing but the answer\n');
  try {
    const outcome = await runCli(directory, 'y');

    assert.equal(outcome.code, 0, outcome.stderr);
    // 轮次的文本走标准输出，问题与统计走标准错误，脚本接的那一份因此是干净的。
    assert.match(outcome.stdout, /^> read the note$/m);
    assert.match(outcome.stdout, /^· read: ok$/m);
    assert.match(outcome.stdout, /the file says so/);
    assert.match(outcome.stderr, /allow read \{"path":"note\.txt"\}\?/);
    assert.match(outcome.stderr, /^session [0-9a-f-]{36}: 2 iterations, 2 model calls$/m);
    // 项目指令那一层进了请求体的系统段（D10 装载侧的接线）。
    assert.match(outcome.requests[0].system, /print nothing but the answer/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ligule run with nobody answering the prompt declines the tool and still finishes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-run-'));
  await writeFile(join(directory, 'note.txt'), 'the body');
  try {
    const outcome = await runCli(directory, null);
    assert.equal(outcome.code, 0, outcome.stderr);
    // 没人答复就是不允许：这一次调用在记录里有一条结果顶着，循环带着它继续问模型（D16、D19）。
    assert.match(outcome.stdout, /^· read: ask_declined$/m);
    assert.match(outcome.stdout, /the file says so/);
    assert.match(outcome.stderr, /2 iterations, 2 model calls/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the model section can lower the declared capability limits but never raise them', () => {
  // 配置快照由层折出来，所以这里给的是一层里的 model 段，与 `--config model.baseURL=...` 走到同一处。
  const model = (extra) => createConfig({ user: { model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model', ...extra } } });

  assert.deepEqual(providerFromConfig(model()).capabilities, MESSAGES_CAPABILITIES);

  const lowered = providerFromConfig(model({ capabilities: { maxOutputTokens: 1024, streaming: false } })).capabilities;
  assert.equal(lowered.maxOutputTokens, 1024, 'a smaller declared number is taken');
  assert.equal(lowered.streaming, false, 'a declared capability can be switched off');
  assert.equal(lowered.parallelToolCalls, false, 'switching one off does not turn another on');

  const raised = providerFromConfig(model({ capabilities: { maxOutputTokens: 99999, parallelToolCalls: true } })).capabilities;
  assert.equal(raised.maxOutputTokens, MESSAGES_CAPABILITIES.maxOutputTokens, 'config cannot raise a limit');
  assert.equal(raised.parallelToolCalls, false, 'config cannot grant an undeclared capability');

  assert.throws(
    () => providerFromConfig(model({ capabilities: { vision: true } })),
    (error) => error.code === 'provider_capability_unknown',
  );
});

test('a malformed retry block in the config is refused instead of quietly disabling retries', () => {
  // 只写一项的块要能补上其余的默认值：非整数的 maxAttempts 让「第几次了」比不出大小，
  // 于是每次传输失败都悄悄变成不重试，而看不出为什么不重试。
  assert.doesNotThrow(() => providerFromConfig(createConfig({
    user: { model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model', retry: { maxAttempts: 5 } } },
  })));

  for (const bad of [{ maxAttempts: '5' }, { maxAttempts: 0 }, { baseDelayMs: 1.5 }, { retry429: 'yes' }]) {
    assert.throws(
      () => providerFromConfig(createConfig({
        user: { model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model', retry: bad } },
      })),
      (error) => error.code === 'host_retry_invalid',
      `a retry block ${JSON.stringify(bad)} is refused`,
    );
  }
});

test('the wire form is named by the config instead of guessed from the address', () => {
  const withApi = (api) => createConfig({
    user: { model: { ...(api === undefined ? {} : { api }), baseURL: 'http://127.0.0.1:1', model: 'test-model' } },
  });

  assert.equal(providerFromConfig(withApi('messages')).name, 'messages');
  assert.equal(providerFromConfig(withApi('chat-completions')).name, 'chat-completions');
  // 没写与写错都要指名：猜错的形状发出去是一份错的请求体，端点回的 400 说不出缺了哪一行。
  for (const api of [undefined, 'responses']) {
    assert.throws(
      () => providerFromConfig(withApi(api)),
      (error) => error.code === 'provider_api_form_required' && /messages/.test(error.detail) && /chat-completions/.test(error.detail),
      `model.api "${String(api)}" is refused`,
    );
  }
});

test('opening a session with no record on disk is refused, and an unknown method is refused', async () => {
  await withHost(async (host) => {
    await assert.rejects(
      host.client.request('session.open', { sessionId: 'no-such-session' }),
      (error) => error.code === 'session_not_found',
    );
    await assert.rejects(
      host.client.request('session.delete', { sessionId: 'whatever' }),
      (error) => error.code === 'protocol_method_unknown',
    );
    await assert.rejects(
      host.client.request('status.get', {}),
      (error) => error.code === 'protocol_args_invalid',
    );

    // 协议表与分发表是同一份东西的两个说法：表里写着的方法不该报「不认识」。
    for (const name of Object.keys(METHODS)) {
      const outcome = await host.client
        .request(name, name === 'run.start' ? { sessionId: 'nobody', input: '' } : { sessionId: 'nobody' })
        .then((result) => result, (error) => error);
      assert.notEqual(outcome?.code, 'protocol_method_unknown', `${name} reaches a handler`);
    }
  });
});

// 同一份协议的第二种载体（D33 的终端界面走的就是这一条）：Host 与客户端在同一个进程里，
// 两端是两根内存流，帧的写法与子进程那一条一模一样，协议与 connection.js 都没有为它改动。
test('the same protocol runs over an in-memory carrier inside one process', async () => {
  await withEndpoint(async (baseUrl) => {
    const directory = await mkdtemp(join(tmpdir(), 'ligule-memory-'));
    await writeFile(join(directory, 'note.txt'), 'the body');
    const previous = process.env.LIGULE_API_KEY;
    process.env.LIGULE_API_KEY = 'test-key';
    try {
      const config = createConfig({
        user: { boundary: directory, model: { api: 'messages', baseURL: baseUrl, model: 'test-model' }, policy: { mode: 'ask' } },
      });
      const pair = createMemoryConnectionPair();
      const host = serveHost({ ...pair.host, config, provider: providerFromConfig(config), policy: config.policy });
      const client = createConnection(pair.client);
      const notified = [];
      const asked = [];
      client.onNotification((message) => notified.push(message.notify === 'event' ? message.event.kind : message.notify));
      client.onRequest((message) => {
        asked.push(message.params.tool);
        // 答复晚一拍：分发器交出 undefined 是「这一条我自己答复」，载体不该替界面先答一个空的「不允许」。
        setTimeout(() => client.reply(message.id, { decision: 'allow' }), 30);
      });

      const { sessionId } = await client.request('session.create', {});
      const result = await client.request('run.start', { sessionId, input: '读 note.txt 并告诉我它写了什么' });

      assert.deepEqual(asked, ['read']);
      assert.equal(result.iterations, 2);
      for (const kind of ['user', 'assistant', 'tool']) assert.ok(notified.includes(kind), `${kind} reaches the client`);
      const { events } = await client.request('session.read', { sessionId });
      const tool = events.find((event) => event.kind === 'tool');
      assert.equal(tool.result.failed, false, 'the late approval reached the decision chain');
      assert.equal(tool.result.content.text, 'the body');
      const status = await client.request('status.get', { sessionId });
      assert.equal(status.running, false);
      assert.ok(status.eventCount >= 4, 'the round is in the record');
      // 判定真正用的那一格跟着这次调用进记录（D77）：这一条是问出来的，答复是允许。
      assert.deepEqual(tool.verdict, { capability: 'read', decision: 'allow', via: 'ask', level: 'ask', answer: 'allow' });

      pair.client.output.end();
      await host.release();
    } finally {
      if (previous === undefined) delete process.env.LIGULE_API_KEY;
      else process.env.LIGULE_API_KEY = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

// 审批那一次问的不只是「要不要跑」：同一条文本在两种语法下能自动放行的面积不一样，
// 答的是那一种、跑起来会是哪一个可执行文件要看得见（D59）。这一条答复的是不允许，不真起进程。
test('an approval for a command names the shell backend the host chose', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-host-shell-'));
  const config = createConfig({
    user: {
      boundary: directory,
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
      policy: { mode: 'ask' },
    },
  });
  let turns = 0;
  // 提供方交回的是已经归一化的那一种事件（`text`、`tool-call`），不是端点线上的那一份帧。
  const provider = {
    capabilities: MESSAGES_CAPABILITIES,
    model: 'test-model',
    async *stream() {
      turns += 1;
      if (turns === 1) {
        yield { type: 'tool-call', id: 'call_1', name: 'exec', args: { command: 'git status' } };
        return;
      }
      yield { type: 'text', text: 'done' };
    },
  };
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy });
  const approvals = [];
  const connection = createConnection(pair.client);
  connection.onRequest(async (message) => {
    approvals.push(message.params);
    return { decision: 'deny' };
  });
  try {
    const { sessionId } = await connection.request('session.create', {});
    await connection.request('run.start', { sessionId, input: 'run it' });
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].tool, 'exec');
    assert.equal(approvals[0].command, 'git status');
    const selection = resolveShell({});
    assert.equal(approvals[0].shell, selection.kind);
    assert.equal(approvals[0].executable, selection.executable);
  } finally {
    pair.client.output.end();
    await host.release();
    await rm(directory, { recursive: true, force: true });
  }
});

// 支线那一份记录读回来的前提（第 35 步、D74）：派生体跑完就把装配撤掉了（D71），
// 它留下的那份文件仍然是同一目录下的会话记录，读它不该要求它在这一刻是打开的，也不为它加一个协议方法。
// 只放开这一种：别的会话没打开就读不到——发现历史归 sessions，接上别的会话归 session.open。
test('a branch of an open session reads back through the same action', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-host-record-read-'));
  const config = createConfig({
    user: {
      boundary: directory,
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
      policy: { mode: 'auto' },
    },
  });
  const provider = {
    capabilities: MESSAGES_CAPABILITIES,
    model: 'test-model',
    async *stream() {
      yield { type: 'text', text: 'done' };
    },
  };
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy });
  const connection = createConnection(pair.client);
  let branchId;
  try {
    const { sessionId } = await connection.request('session.create', {});
    branchId = `${sessionId}.sub-1`;
    await connection.request('run.start', { sessionId, input: '一句话' });
    const { events } = await connection.request('session.read', { sessionId });
    assert.ok(events.some((event) => event.kind === 'user' && event.text === '一句话'), 'the open session reads back');
    assert.ok(events.every((event) => typeof event.seq === 'number'), 'sequence numbers come from the record');

    await writeFile(join(directory, '.ligule', 'sessions', `${branchId}.jsonl`), [
      JSON.stringify({ kind: 'session', formatVersion: 1, sessionId: branchId, projectRoot: directory, createdAt: '2026-10-05T00:00:00.000Z' }),
      JSON.stringify({ seq: 0, kind: 'user', text: 'the delegated task' }),
    ].join('\n') + '\n');
    const branch = await connection.request('session.read', { sessionId: branchId });
    // 首行那份元信息不在事件里（它的序号都没有，D73），交回的是可以拼请求的那几条。
    assert.deepEqual(branch.events.map((event) => event.kind), ['user'], 'the branch of an open session reads back whole');
    assert.equal(branch.events[0].seq, 0, 'the branch numbers on from its own first event');

    // 读不到的那几种要说清各是哪一种：id 不是合法文件名、主干开着而支线不存在、这一份不是此刻任何主干的支线。
    for (const [id, expected] of [
      ['../outside', 'session_id_invalid'],
      [`${sessionId}.sub-9`, 'session_not_found'],
      [`${sessionId}.sub-x`, 'session_not_open'],
      ['nobody', 'session_not_open'],
    ]) {
      await assert.rejects(
        connection.request('session.read', { sessionId: id }),
        (error) => error.code === expected,
        `reading ${id} reports ${expected}`,
      );
    }
    await assert.rejects(connection.request('session.open', { sessionId: '../outside' }), (error) => error.code === 'session_id_invalid');
    await assert.rejects(connection.request('session.open', { sessionId: 'nobody' }), (error) => error.code === 'session_not_found');
    // 支线那份记录在磁盘上，但它不是一份等着接回来的会话：接开它等于在没人负责对的那一份上继续写（D71、D74）。
    await assert.rejects(
      connection.request('session.open', { sessionId: branchId }),
      (error) => error.code === 'session_is_branch' && error.detail.includes(branchId.replace(/\.sub-\d+$/, '')),
      '那一份派生支线的编号说出它是谁的支线',
    );

    // 关掉这条连接上的会话之后支线也不再读得到：这一次动作不是记录目录的浏览器。
    await host.release();
    await assert.rejects(
      connection.request('session.read', { sessionId: branchId }),
      (error) => error.code === 'host_closed',
      'a branch whose trunk is closed is not readable',
    );
  } finally {
    pair.client.output.end();
    await host.release();
    await rm(directory, { recursive: true, force: true });
  }
});

// 手动压缩与状态上那一格（D82、D83，实现顺序第 43 步）：压这件事要调模型、要写检查点，两处都在宿主一侧，
// 所以它是一条协议方法而不是界面里的一个把戏。
async function withInProcessHost(run, limits) {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-host-compact-'));
  const config = createConfig({
    user: {
      boundary: directory,
      model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
      policy: { mode: 'auto' },
      ...(limits === undefined ? {} : { limits }),
    },
  });
  // hold 交进去的那一个 Promise 会挡在提供方回答之前：用来演「这一轮还在跑」。
  let gate;
  const provider = {
    capabilities: MESSAGES_CAPABILITIES,
    model: 'test-model',
    async *stream(request) {
      if (gate !== undefined) await gate;
      // 摘要那一次要答得短，否则「压完更小」这一条在这份假端点上永远不成立（真端点也一样会有这种事）。
      if (String(request.messages?.[0]?.text ?? '').startsWith('Write a summary')) {
        yield { type: 'text', text: 'SUMMARY OF THE EARLIER TURNS' };
        return;
      }
      yield { type: 'text', text: 'a chunk of an answer that is worth summarising '.repeat(30) };
    },
  };
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy });
  const connection = createConnection(pair.client);
  try {
    return await run(connection, { hold: (promise) => { gate = promise; }, directory });
  } finally {
    pair.client.output.end();
    await host.release();
    await rm(directory, { recursive: true, force: true });
  }
}

// 窗口那一格没写时不猜（D75 那条门在这里是同一句说法）：压不动，状态上那一段也不出现。
test('manual compaction refuses when no window is written and the status line says nothing', async () => {
  await withInProcessHost(async (connection) => {
    const { sessionId } = await connection.request('session.create', {});
    await assert.rejects(
      connection.request('session.compact', { sessionId }),
      (error) => error.code === 'compact_window_unset',
      '没有窗口就没有线',
    );
    const status = await connection.request('status.get', { sessionId });
    assert.equal(status.usage, null, '那一格是 null，不是 0');
  });
});

test('manual compaction returns a boundary the status line then reports', async () => {
  await withInProcessHost(async (connection, { hold }) => {
    const { sessionId } = await connection.request('session.create', {});
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    hold(gate);
    const started = connection.request('run.start', { sessionId, input: 'go' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    // 这一轮的上下文已经在路上，这时候压改变不了它（D83）。
    await assert.rejects(
      connection.request('session.compact', { sessionId }),
      (error) => error.code === 'compact_turn_running',
      '跑着的那一轮不压',
    );
    release();
    await started;
    hold(Promise.resolve());
    // 再跑一轮：只有一轮历史时能切的段小得过不了「压完要更小」那条护栏，那是应该的（第 43 步）。
    await connection.request('run.start', { sessionId, input: 'go again' });

    const done = await connection.request('session.compact', { sessionId });
    assert.ok(Number.isInteger(done.fromSeq) && Number.isInteger(done.toSeq) && done.toSeq >= done.fromSeq);
    assert.ok(done.tokensAfter < done.tokensBefore, '压完的投影要比压之前小，不然就不该压');
    const read = await connection.request('session.read', { sessionId });
    assert.ok(read.events.some((event) => event.kind === 'assistant' && String(event.text).includes('worth summarising')),
      '压过一次之后原文一条都没动（D75）');
    const status = await connection.request('status.get', { sessionId });
    assert.equal(status.usage.window, 1200);
    assert.equal(status.usage.threshold, 960);
    assert.equal(status.usage.reported, null, '这个假端点一条用量都没报，报回那一格是 null 而不是 0');
    // 量法那一格界面在读（浮层「本地估算」后面那一句），宿主就得交得出。
    assert.equal(status.usage.measurement, 'request-v1');
    assert.ok(status.usage.estimated > 0);
  }, { contextTokens: 1200 });
});

// 只读的配置展示（实现顺序第 67 步）：宿主只交白名单里那几格，快照里别的东西进不了帧。
test('config.get shows the endpoint block and nothing else from the snapshot', async () => {
  await withInProcessHost(async (connection, { directory }) => {
    const shown = await connection.request('config.get', {});
    assert.deepEqual(Object.keys(shown), ['model'], '交回来的只有一格 model');
    assert.deepEqual(Object.keys(shown.model).sort(), ['api', 'baseURL', 'model'], '端点那三样；这份配置没写 apiKeyEnv，那一格就不出现');
    const frame = JSON.stringify(shown);
    assert.ok(!frame.includes(directory), '边界那一个目录不进帧：那是这台机器上的位置');
    assert.ok(!frame.includes('auto'), '判定档位不在这一条里读，它走 status.get（D40）');
    // 这条路不收参数：多写的那一格不会被读，也换不来白名单之外的一格。
    // 边界不在参数校验上（子集校验放过模式里没声明的键），在结果由固定四格拼出来那一句上。
    assert.deepEqual(Object.keys(await connection.request('config.get', { path: 'policy.mode' })), ['model']);
  });
});

// 展示值由宿主拼：每一格要先是字符串，地址只留协议、主机、端口与路径那一段（实现顺序第 67 步）。
test('shownConfigOf keeps the displayable part of each field', () => {
  assert.deepEqual(shownConfigOf({ model: { api: 'messages', baseURL: 'https://user:secret@api.example.test:8443/v1?token=abc#frag', model: 42 } }), {
    model: { api: 'messages', baseURL: 'https://api.example.test:8443/v1', model: undefined, apiKeyEnv: undefined },
  });
  // 解析不出来的地址不猜着交：那一格就没有，界面上说「读不出来或没写」。
  assert.deepEqual(shownConfigOf({ model: { baseURL: 'not a url' } }), { model: { api: undefined, baseURL: undefined, model: undefined, apiKeyEnv: undefined } });
  assert.deepEqual(shownConfigOf({}), { model: { api: undefined, baseURL: undefined, model: undefined, apiKeyEnv: undefined } });
});

// 一具宿主接两个项目（实现顺序第 69 步，方案 3.1 与 3.2）：会话属于哪一个项目，记录就落在
// 那一个项目的记录目录里，那一个项目的列表才列得出它。装载不出别的项目环境的宿主直接说不支持。
test('one host keeps two projects apart, and a host without a loader says so', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-projects-'));
  const first = join(root, 'first');
  const second = join(root, 'second');
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  const quiet = { capabilities: MESSAGES_CAPABILITIES, model: 'test-model', async *stream() { yield { type: 'text', text: 'ok' }; } };
  const environmentOf = (projectRoot) => ({
    config: createConfig({ user: { boundary: projectRoot, model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' } } }),
    provider: quiet,
    policy: { mode: 'auto' },
  });
  const pair = createMemoryConnectionPair();
  let loaded = 0;
  const host = serveHost({
    input: pair.host.input,
    output: pair.host.output,
    ...environmentOf(first),
    loadEnvironment: async (projectRoot) => {
      loaded += 1;
      return environmentOf(projectRoot);
    },
  });
  const client = createConnection(pair.client);
  const bare = createMemoryConnectionPair();
  const bareHost = serveHost({ input: bare.host.input, output: bare.host.output, ...environmentOf(first) });
  const bareClient = createConnection(bare.client);
  try {
    const inSecond = await client.request('session.create', { projectRoot: second });
    // 首行那份元信息在第一次落笔时才写，所以先跑一轮，再读那一份记录属于谁（D73）。
    await client.request('run.start', { sessionId: inSecond.sessionId, input: '另一轮' });
    const header = JSON.parse((await readFile(join(second, '.ligule', 'sessions', `${inSecond.sessionId}.jsonl`), 'utf8')).split('\n')[0]);
    assert.equal(header.projectRoot, second, '首行说得出这一份记录属于哪个项目');

    const listedHere = await client.request('sessions.list', {});
    assert.ok(!listedHere.sessions.some((item) => item.id === inSecond.sessionId), '当前项目的列表不替别的项目说话');
    const listedThere = await client.request('sessions.list', { projectRoot: second });
    assert.ok(listedThere.sessions.some((item) => item.id === inSecond.sessionId), '指名那个项目才列得出它');

    // 两个项目各开一份会话，交错跑一轮：各自的记录进各自的目录，互不串。
    const inFirst = await client.request('session.create', {});
    await client.request('run.start', { sessionId: inFirst.sessionId, input: '第一轮' });
    assert.ok((await readFile(join(first, '.ligule', 'sessions', `${inFirst.sessionId}.jsonl`), 'utf8')).includes('第一轮'));
    assert.ok((await readFile(join(second, '.ligule', 'sessions', `${inSecond.sessionId}.jsonl`), 'utf8')).includes('另一轮'));

    // 那一个根上最后一份会话收了，那份项目环境就退出这张表：下一次开这一根的会话重新读配置那几层（方案 3.1、实现顺序第 70 步）。
    await client.request('session.close', { sessionId: inSecond.sessionId });
    const loadedBefore = loaded;
    await client.request('session.open', { sessionId: inSecond.sessionId, projectRoot: second });
    assert.equal(loaded, loadedBefore + 1, '收了最后一份会话之后，那一份项目环境重新装载一次');

    await assert.rejects(
      bareClient.request('session.create', { projectRoot: second }),
      (error) => error.code === 'host_project_root_unsupported',
      '装载侧没给那条路时说出来，不用当前这一份项目环境去读别的项目',
    );
  } finally {
    pair.client.output.end();
    bare.client.output.end();
    await host.release();
    await bareHost.release();
    await rm(root, { recursive: true, force: true });
  }
});

// 一份会话收了（实现顺序第 70 步）：交回的是那一次装配与那一份记录锁，记录本身一个字都不动（I1、D85）。
// 正在跑的那一轮不由这一次动作收尾，所以 close 先问一句，不打断。
test('closing a session hands back its record lock and leaves the record alone', async () => {
  await withInProcessHost(async (connection) => {
    const { sessionId } = await connection.request('session.create', {});
    await connection.request('run.start', { sessionId, input: '说一句' });
    const before = await connection.request('session.read', { sessionId });

    assert.deepEqual(await connection.request('session.close', { sessionId }), { sessionId });
    await assert.rejects(
      connection.request('session.read', { sessionId }),
      (error) => error.code === 'session_not_open',
      '收了之后读不到的是这一份装配，不是那一份记录',
    );

    // 锁真的交回来了：同一路径上再要一次独占锁，拿不到就报 `session_locked`，接不上这一段就停在这里。
    const reopened = await connection.request('session.open', { sessionId });
    assert.deepEqual(reopened, { sessionId });
    const after = await connection.request('session.read', { sessionId });
    assert.deepEqual(after.events, before.events, '收过一次之后，记录里的事件一条没多、一条没少');
  });
});

// 收尾失败也不留没人能收的会话，而正在跑的那一轮更不让它被偷偷收掉：两条都在 close 这一条路上验。
test('closing a session while its round runs says so instead of interrupting', async () => {
  await withInProcessHost(async (connection, { hold }) => {
    const { sessionId } = await connection.request('session.create', {});
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    hold(gate);
    const running = connection.request('run.start', { sessionId, input: '慢一点' });
    await delay(50);
    await assert.rejects(
      connection.request('session.close', { sessionId }),
      (error) => error.code === 'run_already_running',
      'close 不暗中打断正在跑的那一轮',
    );
    release(undefined);
    await running;
    await connection.request('session.close', { sessionId });
    await assert.rejects(
      connection.request('status.get', { sessionId }),
      (error) => error.code === 'session_not_open',
    );
  });
});

// 历史那一页（实现顺序第 72 步，方案 4.1）：游标用的是记录里那一条事件自己的序号，它稳定也单调。
// 往回翻只说「比这一页最早那一条更早」，所以翻页期间新到的事件只追加在末尾，旧页既不重复也不漏。
test('a history page names its own end and an older page picks up where it stopped', async () => {
  await withInProcessHost(async (connection) => {
    const { sessionId } = await connection.request('session.create', {});
    await connection.request('run.start', { sessionId, input: '第一轮' });
    await connection.request('run.start', { sessionId, input: '第二轮' });

    const newest = await connection.request('session.read', { sessionId, limit: 3 });
    assert.equal(newest.events.length, 3, '说了三条就交三条');
    assert.deepEqual(newest.events.map((event) => event.seq), [newest.endSeq - 2, newest.endSeq - 1, newest.endSeq], '序号连着一段，页内从早到晚');
    assert.equal(newest.hasMore, true, '更早的那些还在后面');

    const older = await connection.request('session.read', { sessionId, limit: 3, before: newest.events[0].seq });
    assert.equal(older.events.at(-1).seq, newest.events[0].seq - 1, '上一页的最早一条正好接在下一页的最后一条之后');
    assert.ok(older.events.every((event) => event.seq < newest.events[0].seq), '游标之外的一条也不给');

    // 再跑一轮：新事件只在末尾出现，手里那一页旧记录按同一个游标重读还是那三条。
    await connection.request('run.start', { sessionId, input: '第三轮' });
    const again = await connection.request('session.read', { sessionId, limit: 3, before: newest.events[0].seq });
    assert.deepEqual(again.events.map((event) => event.seq), older.events.map((event) => event.seq), '旧页不重复也不漏');
    const tail = await connection.request('session.read', { sessionId, limit: 3 });
    assert.ok(tail.endSeq > newest.endSeq, '快照末端跟着新事件往前走');

    const whole = await connection.request('session.read', { sessionId });
    assert.equal(whole.hasMore, false, '不带那一格就是整份记录，前面没有更早的');
    assert.ok(whole.events.length > tail.events.length, '整份读仍然比一页多');

    await assert.rejects(
      connection.request('session.read', { sessionId, before: 9999 }),
      (error) => error.code === 'session_cursor_invalid',
      '认不出这一份记录里那条序号的游标要说失效，不能静默当成第一页',
    );
  });
});

// 命名与归档（实现顺序第 75 步）：宿主写成记录里的一条事实，列表读的是同一份，界面不留第二份。
test('naming or archiving a session appends one fact the listing reads back', async () => {
  await withInProcessHost(async (connection) => {
    const { sessionId } = await connection.request('session.create', {});
    await connection.request('run.start', { sessionId, input: '说一句' });
    assert.deepEqual(
      await connection.request('session.label', { sessionId, name: ' 读数那一轮 ' }),
      { sessionId, name: '读数那一轮', archived: false },
      '两端读的是同一份事实',
    );
    assert.deepEqual(
      await connection.request('session.label', { sessionId, archived: true }),
      { sessionId, name: '读数那一轮', archived: true },
      '只说归档时名字沿用，不是清掉',
    );
    const listed = (await connection.request('sessions.list', {})).sessions.find((item) => item.id === sessionId);
    assert.equal(listed.name, '读数那一轮', '列表那一处读的是记录里折出来的当前值');
    assert.equal(listed.archived, true);
    await assert.rejects(
      connection.request('session.label', { sessionId, name: '   ' }),
      (error) => error.code === 'session_name_invalid',
      '整条空白不算一个名字',
    );
    await assert.rejects(
      connection.request('session.label', { sessionId }),
      (error) => error.code === 'session_label_empty',
      '什么都不改的一次调用要说出为什么不改',
    );
  });
});

// 跨会话查找（实现顺序第 76 步，方案 4.2）：查的是宿主那一份记录目录，交回的是「哪一份会话的第几条」。
test('a search over the records names the session and the event each hit is in', async () => {
  await withInProcessHost(async (connection) => {
    const { sessionId } = await connection.request('session.create', {});
    await connection.request('run.start', { sessionId, input: '读数那一段跑一遍' });
    const hits = (await connection.request('sessions.search', { query: '读数' })).hits;
    assert.deepEqual([hits[0].sessionId, hits[0].kind, hits[0].seq], [sessionId, 'user', 0], '命中的是记录里那一条用户输入');
    assert.ok(hits[0].text.includes('读数'), '摘录带着命中那一段');
    assert.ok(hits.every((hit) => hit.sessionId === sessionId), '这个项目根下只跑过这一份会话');
    assert.deepEqual((await connection.request('sessions.search', { query: '没有这段文字' })).hits, [], '查不到不是错误');
    // 指名一份就只扫那一份记录，溢出在另一个文件里的那一段也读（方案 4.2 的完整工具结果）。
    const scoped = await connection.request('sessions.search', { query: '读数', sessionId });
    assert.ok(scoped.hits.length > 0 && scoped.hits.every((hit) => hit.sessionId === sessionId), '指名一份就只交那一份的命中');
    await assert.rejects(
      connection.request('sessions.search', { query: '读数', sessionId: '../outside' }),
      (error) => error.code === 'session_id_invalid',
      '会话编号要拼成记录文件名，形状先查，不混进「找不到这份会话」',
    );
    await assert.rejects(
      connection.request('sessions.search', { query: '   ' }),
      (error) => error.code === 'search_query_empty',
      '空白的查询在每份记录里都能对上，那一份结果没有意义，扫之前就说清',
    );
  });
});
