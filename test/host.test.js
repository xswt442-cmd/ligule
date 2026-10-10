// 第 14 步的验收：一个子进程经标准输入输出上的这条协议跑完一轮（D30），全程不开端口。
// 模型那一侧是本地起的真实 HTTP 服务按 SSE 一帧一帧写出去，与 test/provider.test.js 同一种测法；
// 进程、流、审批往返回与落盘的记录都是真的，没有假实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createConnection, createConfig, createMemoryConnectionPair, MESSAGES_CAPABILITIES, METHODS, NOTIFICATIONS, providerFromConfig, hostProviderFromConfig, resolveShell, serveHost } from '../dist/index.js';
import { shownConfigOf } from '../dist/host/host.js';
import { createConfigStore } from '../dist/kernel/config-store.js';
import { configVersion } from '../dist/kernel/config-edit.js';
import { historyPathOf, rememberHistory } from '../dist/kernel/input-history.js';
import { listProjectFiles } from '../dist/host/paths.js';
import { listenFetchable } from './helpers/port.js';

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
  const port = await listenFetchable(server);
  try {
    return await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

// 起一个 Host 子进程，并在它的标准输入输出两端装好这条协议的客户端。
// --config 的值是一段 TOML，所以字符串要带引号（D8 那一条装载规则）。
// HOME 与 USERPROFILE 指到这个临时目录：命令行为读真实主目录下的用户层配置，那一份属于这台机器，
// 它写了 `model.apiKeyEnv` 就会盖掉这里设的 `LIGULE_API_KEY`，本机配了什么测试就跟着变红。
function startHost(directory, baseUrl, extra = []) {
  const child = spawn(process.execPath, [
    CLI, 'host',
    '--config', 'model.api="messages"',
    '--config', `model.baseURL="${baseUrl}"`,
    '--config', 'model.model="test-model"',
    '--config', 'policy.mode="ask"',
    ...extra,
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
async function withHost(run, extra = []) {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-host-'));
  await writeFile(join(directory, 'note.txt'), 'the body');
  try {
    return await withEndpoint(async (baseUrl) => {
      const host = startHost(directory, baseUrl, extra);
      const notifications = [];
      const approvals = [];
      host.client.onNotification((message) => notifications.push(message));
      try {
        return await run(host, { notifications, approvals, directory, baseUrl, startAnother: () => startHost(directory, baseUrl, extra) });
      } finally {
        await stop(host);
      }
    });
  } finally {
    // Windows 上刚退出的子进程那一份工作目录句柄不一定立刻放掉：删不动时重试一小段，别把 EBUSY 报成测试失败。
    for (let tries = 0; tries < 40; tries += 1) {
      try {
        await rm(directory, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code !== 'EBUSY') throw error;
        await delay(50);
      }
    }
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
    // 那一次询问带着属于它自己的那一项目录：客户端看着别的那一份时，答的是那一个项目里的这一步。
    // 两边写法可以不同而指同一处目录：macOS 上 `/var` 是 `/private/var` 的一条链接，Windows 的 runner 把临时目录给成 8.3 的短名（`RUNNER~1`）。
    // 这一格要的是「同一处目录」，所以比较之前两边都取真实路径；宿主那一份交回的仍是它自己认的那一处，没有被这一趟改写。
    assert.equal(await realpath(approvals[0].projectRoot), await realpath(directory));
    // 没有命令文本的调用不带后端那两样：那一种语法与哪一个可执行文件对读一次文件这件事没有意义。
    assert.equal(approvals[0].shell, undefined);
    assert.equal(approvals[0].executable, undefined);

    const deltas = notifications.filter((message) => message.notify === 'delta').map((message) => message.event);
    assert.deepEqual(deltas.map((event) => event.type), ['tool-call', 'text'], 'the stream is forwarded as it arrives');
    assert.ok(notifications.every((message) => NOTIFICATIONS.includes(message.notify)), 'nothing arrives outside the names the protocol declares');
    const events = notifications.filter((message) => message.notify === 'event').map((message) => message.event);
    // 装载先记一条模式事件：那一份清单是这一轮工具栏目的来源（I2、I5）。
    // 最后那一条是轮次完成标记：它跟在助手那一条之后，不进投影（实现顺序第 68 步）。
    assert.deepEqual(events.map((event) => event.kind), ['mode', 'user', 'turnContext', 'assistant', 'tool', 'assistant', 'turn']);
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
      assert.deepEqual(reopened.events.map((event) => event.kind), ['mode', 'user', 'turnContext', 'assistant', 'tool', 'assistant', 'turn']);
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
    // Windows 上刚退出的子进程那一份工作目录句柄不一定立刻放掉：删不动时重试一小段，别把 EBUSY 报成测试失败。
    for (let tries = 0; tries < 40; tries += 1) {
      try {
        await rm(directory, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code !== 'EBUSY') throw error;
        await delay(50);
      }
    }
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
    // Windows 上刚退出的子进程那一份工作目录句柄不一定立刻放掉：删不动时重试一小段，别把 EBUSY 报成测试失败。
    for (let tries = 0; tries < 40; tries += 1) {
      try {
        await rm(directory, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code !== 'EBUSY') throw error;
        await delay(50);
      }
    }
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
async function withInProcessHost(run, limits, extra = {}) {
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
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy, ...extra });
  const connection = createConnection(pair.client);
  // 界面上填过端点那两格之后，派出来的那一份提供方读的是环境变量里的凭据：这一份检查自己设一个，别跟着开发机上有没有配过东西变红。
  const previousKey = process.env.LIGULE_API_KEY;
  process.env.LIGULE_API_KEY = 'test-key';
  try {
    return await run(connection, { hold: (promise) => { gate = promise; }, directory });
  } finally {
    if (previousKey === undefined) delete process.env.LIGULE_API_KEY;
    else process.env.LIGULE_API_KEY = previousKey;
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
    assert.deepEqual(Object.keys(shown).sort(), ['layers', 'model', 'sources'], '交出来的是那格端点、可写的那几层与每条的来源');
    assert.deepEqual(Object.keys(shown.model).sort(), ['api', 'baseURL', 'model'], '端点那三样；这份配置没写 apiKeyEnv，那一格就不出现');
    assert.deepEqual(shown.layers, [], '启动这一侧没给写入口时那一格是空的：这一具宿主不知道该往哪里写');
    assert.deepEqual(shown.sources, {}, '没有那一格时来源也说不出来，不猜一条');
    await assert.rejects(
      () => connection.request('config.set', { field: 'model.model', value: 'x', layer: 'user', version: '' }),
      (error) => error.code === 'config_write_unsupported',
    );
    const frame = JSON.stringify(shown);
    assert.ok(!frame.includes(directory), '边界那一个目录不进帧：那是这台机器上的位置');
    assert.ok(!frame.includes('auto'), '这一具宿主没有配置文件的读写口，档位读不出来那一格就不出现：正在生效的那一份走 status.get（D40）');
    // 这条路不收参数：多写的那一格不会被读，也换不来白名单之外的一格。
    // 边界不在参数校验上（子集校验放过模式里没声明的键），在结果由固定四格拼出来那一句上。
    assert.deepEqual(Object.keys(await connection.request('config.get', { path: 'policy.mode' })).sort(), ['layers', 'model', 'sources']);
  });
});

// 写配置那一条路（实现顺序第 90 步，方案 7.2）：字段与层由宿主持有，别的一格都说不出口；
// 那份文件被别人改过时报冲突而不是盖掉他的改动。
test('config.set writes one whitelisted field and reports a concurrent edit instead of overwriting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-config-set-'));
  const home = join(root, 'home');
  const userFile = join(home, '.ligule', 'config.toml');
  await mkdir(dirname(userFile), { recursive: true });
  const original = '# 我的默认\n[model]\nmodel = "旧的"\napi = "messages" # 线上形状\n';
  await writeFile(userFile, original, 'utf8');
  const store = createConfigStore({ projectRoot: root, userHome: home, layers: { user: { model: { api: 'messages', model: '旧的' } } } });
  try {
    await withInProcessHost(async (connection) => {
      const first = await connection.request('config.get', {});
      assert.deepEqual(first.layers.map((layer) => layer.layer), ['user', 'projectLocal']);
      const [user, local] = first.layers;
      assert.equal(user.exists, true);
      assert.equal(local.version, '', '那一份项目本机覆盖还没写过：版本是空串');
      assert.ok(!JSON.stringify(first.layers).includes(home), '帧里没有文件路径：那格只说层名与版本');
      assert.deepEqual(first.sources, { 'model.api': 'user', 'model.model': 'user', 'model.baseURL': 'none', 'model.apiKeyEnv': 'none', 'policy.mode': 'none', 'policy.rules': 'none' }, '来源说的是装载那一次读到的四层，没写的那一格是 none');

      const written = await connection.request('config.set', { field: 'model.model', value: '新的', layer: 'user', version: user.version });
      assert.equal(written.created, false);
      const text = await readFile(userFile, 'utf8');
      assert.ok(text.includes('model = "新的"'), text);
      assert.ok(text.includes('# 我的默认'), '整行的注释留着');
      assert.ok(text.includes('api = "messages" # 线上形状'), '没编辑那一条一个字节都没动');
      assert.equal(written.version, configVersion(text), '交回的新版本就是刚落盘的那一份');

      // 另一份进程或人自己开的编辑器在这之后改过：这一次写不进去，他的那份留着。
      const outside = text.replace('新的', '别人写的');
      await writeFile(userFile, outside, 'utf8');
      await assert.rejects(
        () => connection.request('config.set', { field: 'model.model', value: '我要写的', layer: 'user', version: written.version }),
        (error) => error.code === 'config_version_stale',
      );
      assert.equal(await readFile(userFile, 'utf8'), outside, '冲突那一次一个字都没写');

      // 那一份不在的层可以写第一次：版本交回空串，写完才在。
      const fresh = await connection.request('config.set', { field: 'model.api', value: 'chat-completions', layer: 'projectLocal', version: '' });
      assert.equal(fresh.created, true);
      assert.ok((await readFile(join(root, '.ligule', 'config.local.toml'), 'utf8')).includes('api = "chat-completions"'));
      assert.equal(fresh.shadowed, false, '命令行那一层没写这一条：这一笔改得动');
      assert.equal((await connection.request('config.get', {})).sources['model.api'], 'local', '写完那一条之后，来源跟着变成本机覆盖那一层');

      // 档位与规则表现在在白名单里（D100、D101）：档位是一条标量，规则表按整块动作写。
      const current = (await connection.request('config.get', {})).layers.find((layer) => layer.layer === 'user').version;
      const tier = await connection.request('config.set', { field: 'policy.mode', value: 'auto', layer: 'user', version: current });
      assert.equal(tier.created, true, '那一份文件里原来没有 [policy]，补一张表');
      const added = await connection.request('config.set', {
        field: 'policy.rules',
        op: 'add',
        layer: 'user',
        version: tier.version,
        ruleTool: 'read',
        ruleDecision: 'allow',
      });
      assert.deepEqual(added.rules, [{ tool: 'read', decision: 'allow' }], '交回的是写完那一张表');
      const shown = await connection.request('config.get', {});
      assert.deepEqual(shown.rules, [{ tool: 'read', decision: 'allow' }]);
      assert.equal(shown.rulesSource, 'user', '生效那一份出自使用者默认这一层');
      assert.equal(shown.sources['policy.mode'], 'user');
      await assert.rejects(
        () => connection.request('config.set', {
          field: 'policy.rules',
          op: 'add',
          layer: 'user',
          version: added.version,
          ruleTool: 'read',
          ruleDecision: 'maybe',
        }),
        (error) => error.code === 'config_rule_invalid',
        '非法的档位不落盘',
      );

      // 白名单之外、层名不对、值的形状不对：三条都当场说出来，且都问不出一个路径。
      const kept = await readFile(userFile, 'utf8');
      await assert.rejects(
        () => connection.request('config.set', { field: 'policy.secret', value: 'auto', layer: 'user', version: current }),
        (error) => error.code === 'config_field_unknown',
      );
      await assert.rejects(
        () => connection.request('config.set', { field: 'model.model', value: 'x', layer: 'project', version: '' }),
        (error) => error.code === 'config_layer_unknown',
        '项目共享那一份不在可写的两层里',
      );
      await assert.rejects(
        () => connection.request('config.set', { field: 'model.baseURL', value: 'https://a:b@c.example.test/v1', layer: 'user', version: written.version }),
        (error) => error.code === 'config_field_value',
      );
      assert.equal(await readFile(userFile, 'utf8'), kept, '被拒的那几次都没碰那份文件');
    }, undefined, { configStore: store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 方案 3A：设置那一栏的值、来源与那一份版本出自同一遍读取，读的是可写那两层文件此刻的内容。
// 打开这一栏是一次纯读：正在跑的会话用的那一份提供方、档位与规则都不动。
test('the settings panel reads value, source and version in one pass and changes nothing in effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-one-read-'));
  const home = join(root, 'home');
  const userFile = join(home, '.ligule', 'config.toml');
  await mkdir(dirname(userFile), { recursive: true });
  await writeFile(userFile, '[model]\nmodel = "文件里那一份"\n', 'utf8');
  const store = createConfigStore({ projectRoot: root, userHome: home, layers: { user: { model: { model: '装载时那一份' } } } });
  try {
    await withInProcessHost(async (connection) => {
      const { sessionId } = await connection.request('session.create', {});
      const before = await connection.request('status.get', { sessionId });
      const shown = await connection.request('config.get', {});
      assert.equal(shown.model.model, '文件里那一份', '屏幕上那一份是文件此刻的内容，不是装载那一次的快照');
      assert.equal(shown.sources['model.model'], 'user');
      assert.equal(shown.layers[0].version, configVersion(await readFile(userFile, 'utf8')), '那一份版本与那一个值出自同一遍读取');
      assert.equal(shown.policyMode, undefined, '四层里没写档位时那一格是空的，界面不替配置文件猜一档');
      assert.equal(shown.sources['policy.mode'], 'none');
      const after = await connection.request('status.get', { sessionId });
      assert.equal(after.model, before.model, '读一遍设置不改这一份会话正在用的那一份模型');
      assert.equal(after.policy, before.policy, '也不改正在生效的那一档');

      // 别的过程或人自己开的编辑器在这之后改了那一份文件：下一次读，值、来源与版本一起跟着换成新的那一份。
      await writeFile(userFile, '[model]\nmodel = "别人写的"\n[policy]\nmode = "auto"\n', 'utf8');
      const again = await connection.request('config.get', {});
      assert.equal(again.model.model, '别人写的');
      assert.equal(again.policyMode, 'auto', '文件里写着的默认档现在读得出来');
      assert.equal(again.sources['policy.mode'], 'user');
      assert.equal(again.layers[0].version, configVersion(await readFile(userFile, 'utf8')));
      assert.equal((await connection.request('status.get', { sessionId })).policy, before.policy, '正在生效的那一份还是装载时的：外部改文件不走过这一具宿主的写入那一路');
    }, undefined, { configStore: store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 命令行那一层写着的一条，改文件盖不过它（D8 的次序、方案 7.1 的「不能声称改低层文件即可生效」）：
// 这一笔说成 shadowed，正在用的提供方与任何会话都不动。
test('a field the command line wrote is reported as shadowed instead of adopted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-shadowed-'));
  const home = join(root, 'home');
  const userFile = join(home, '.ligule', 'config.toml');
  await mkdir(dirname(userFile), { recursive: true });
  const original = '[model]\nmodel = "文件里写的那一份"\n';
  await writeFile(userFile, original, 'utf8');
  const store = createConfigStore({
    projectRoot: root,
    userHome: home,
    layers: { user: { model: { model: '文件里写的那一份' } }, flag: { model: { model: '命令行写的那一份' } } },
  });
  try {
    await withInProcessHost(async (connection) => {
      const { sessionId } = await connection.request('session.create', {});
      const shown = await connection.request('config.get', {});
      assert.equal(shown.sources['model.model'], 'flag', '最高那一层写着的那一条读得出来');
      const answer = await connection.request('config.set', { field: 'model.model', value: '改文件的那一份', layer: 'user', version: shown.layers[0].version });
      assert.equal(answer.shadowed, true);
      assert.deepEqual(answer.applies, [], '没有一份会话采用它');
      assert.ok(answer.version, '文件那一笔还是写成了：说的是盖不过，不是没写');
      assert.equal((await connection.request('status.get', { sessionId })).model, 'test-model', '正在用的那一份提供方不动');
      assert.ok((await readFile(userFile, 'utf8')).includes('model = "改文件的那一份"'), '文件里是那一句新值');
    }, undefined, { configStore: store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 同一层次序的另一头（审阅 F1）：项目共享那一份写着档位时，把使用者默认存成别的档位不该改变任何会话在判的那一档。
// 盖没盖住由折完整四层说，不由「是不是命令行写的」说；交回的 `shadowedBy` 指名是哪一层盖着它。
test('a tier saved into a lower layer that the project layer overrides adopts nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-tier-override-'));
  const home = join(root, 'home');
  const userFile = join(home, '.ligule', 'config.toml');
  await mkdir(dirname(userFile), { recursive: true });
  await writeFile(userFile, '[model]\nmodel = "文件里那一份"\n', 'utf8');
  const store = createConfigStore({ projectRoot: root, userHome: home, layers: { user: { model: { model: '文件里那一份' } }, project: { policy: { mode: 'ask' } } } });
  try {
    await withInProcessHost(async (connection) => {
      const { sessionId } = await connection.request('session.create', {});
      const shown = await connection.request('config.get', {});
      assert.equal(shown.sources['policy.mode'], 'project', '生效那一份由项目共享那一层写着');
      assert.equal(shown.policyMode, 'ask', '屏幕上那一份默认档是折完四层之后的');
      const answer = await connection.request('config.set', { field: 'policy.mode', value: 'auto', layer: 'user', version: shown.layers[0].version });
      assert.equal(answer.shadowed, true);
      assert.equal(answer.shadowedBy, 'project', '说的是哪一层盖住了这一笔');
      assert.deepEqual(answer.applies, [], '前后折出来是同一份，没有一份会话要采用它');
      assert.equal((await connection.request('status.get', { sessionId })).policy, 'ask', '正在判的那一档没被低一层的写入放宽');
      assert.ok((await readFile(userFile, 'utf8')).includes('mode = "auto"'), '文件那一笔还是写成了：说的是当前运行没变，不是没写');
    }, undefined, { configStore: store, policy: { mode: 'ask' } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 连着改两条生成字段（审阅 F2）：后一次重建提供方用的是这一格项目环境此刻的那一份完整选择，
// 不是装载那一次的快照，所以改服务地址不会把刚改过的模型名退回装载时那一份。
test('two saves of generation fields compose instead of reverting the first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-two-edits-'));
  const home = join(root, 'home');
  const userFile = join(home, '.ligule', 'config.toml');
  await mkdir(dirname(userFile), { recursive: true });
  await writeFile(userFile, '[model]\nmodel = "旧的"\n', 'utf8');
  const store = createConfigStore({ projectRoot: root, userHome: home, layers: { user: { model: { model: '旧的' } } } });
  try {
    await withInProcessHost(async (connection) => {
      const { sessionId } = await connection.request('session.create', {});
      const first = await connection.request('config.set', { field: 'model.model', value: '改过的模型', layer: 'user', version: (await connection.request('config.get', {})).layers[0].version });
      assert.deepEqual(first.applies.map((item) => item.when), ['now'], '空着的会话立刻采用');
      assert.equal((await connection.request('status.get', { sessionId })).model, '改过的模型');
      const shown = await connection.request('config.get', {});
      const second = await connection.request('config.set', { field: 'model.baseURL', value: 'https://edited.test/v1', layer: 'user', version: shown.layers[0].version });
      assert.deepEqual(second.applies.map((item) => item.when), ['now']);
      const status = await connection.request('status.get', { sessionId });
      assert.equal(status.model, '改过的模型', '改地址那一笔没把模型名退回装载时那一份');
      assert.equal(status.pendingModel, null, '空着的会话没有等在边界的另一份');
      const text = await readFile(userFile, 'utf8');
      assert.ok(text.includes('model = "改过的模型"') && text.includes('baseURL = "https://edited.test/v1"'), '两份都落在那一份文件里');
      assert.equal((await connection.request('config.get', {})).model.baseURL, 'https://edited.test/v1', '屏幕上说的与运行里打的是同一份');
    }, undefined, { configStore: store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 保存过模型字段之后新开的一份会话：状态、这一份会话在打的提供方与轮次记录读的是同一份生成选择。
// 装载那一次的配置快照在这一笔写入之后仍是旧的那一份，新会话从它起就会让 `status.get` 说新的、
// 记录里的 `turnContext` 说旧的，两份读数各讲各的（方案 7.2 与 D104 在同一格上相遇）。
// 提供方是按那一份折出来的配置重建的，所以这一趟打到本机端点上的请求体自己就是第三条证据。
test('a session created after a model save inherits the generation the environment is on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-inherit-generation-'));
  const home = join(root, 'home');
  const userFile = join(home, '.ligule', 'config.toml');
  await mkdir(dirname(userFile), { recursive: true });
  await writeFile(userFile, '[model]\nmodel = "装载那一份"\n', 'utf8');
  const store = createConfigStore({ projectRoot: root, userHome: home, layers: { user: { model: { model: '装载那一份' } } } });
  try {
    await withEndpoint(async (baseUrl, requests) => {
      await withInProcessHost(async (connection) => {
        const first = await connection.request('config.get', {});
        await connection.request('config.set', { field: 'model.model', value: '保存那一份', layer: 'user', version: first.layers[0].version });
        const second = await connection.request('config.get', {});
        await connection.request('config.set', { field: 'model.baseURL', value: baseUrl, layer: 'user', version: second.layers[0].version });
        const { sessionId } = await connection.request('session.create', {});
        assert.equal((await connection.request('status.get', { sessionId })).model, '保存那一份', '新开的一份继承的是这一份环境此刻的那一份');
        await connection.request('run.start', { sessionId, input: 'say it' });
        const record = await connection.request('session.read', { sessionId, limit: 50 });
        const context = record.events.find((event) => event.kind === 'turnContext');
        assert.notEqual(context, undefined, '开轮那一份参数快照要落进记录');
        assert.equal(context.model, '保存那一份', '记录里那一份与状态里那一份同源');
        assert.equal(requests.at(-1).model, '保存那一份', '真正打到端点上的那一份请求带的也是它');
      }, undefined, { configStore: store });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 一具宿主开了 A、B 两份项目的会话之后，设置那一栏读写的是「现在说的那一个项目」自己那两层文件（方案 3.2、审阅 F3）。
// 往本机覆盖那一层写的一笔只属于那一个项目；往使用者默认那一层写的一笔，两份项目各按自己折出来的那一份采用。
test('the settings panel reads and writes the project it names, and a shared default lands on each project its own way', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-project-settings-'));
  const a = join(root, 'a');
  const b = join(root, 'b');
  const home = join(root, 'home');
  await mkdir(join(b, '.ligule'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(b, '.ligule', 'config.local.toml'), '[model]\nmodel = "B 那一份"\n', 'utf8');
  const environmentOf = (projectRoot) => {
    const config = createConfig({ user: { boundary: projectRoot, model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' } } });
    // 提供方按命令行与宿主那一条路从这份配置建出来（`providerFromConfig`），不再是本检查自己造的格子：
    // 线上形状、能力上限与地址校验都在这一步真走过。这一趟不发请求，那一格地址不会被碰到。
    return { config, provider: providerFromConfig(config), policy: config.policy, layers: {} };
  };
  const pair = createMemoryConnectionPair();
  const host = serveHost({
    input: pair.host.input,
    output: pair.host.output,
    ...environmentOf(a),
    loadEnvironment: async (projectRoot) => environmentOf(projectRoot),
    configLayers: {},
    configStoreFor: (projectRoot, layers) => createConfigStore({ projectRoot, userHome: home, layers }),
  });
  const client = createConnection(pair.client);
  try {
    const inA = await client.request('session.create', {});
    const inB = await client.request('session.create', { projectRoot: b });

    const shownB = await client.request('config.get', { projectRoot: b });
    assert.equal(shownB.model.model, 'B 那一份', '指名 B 就读 B 的本机覆盖那一层');
    assert.equal(shownB.sources['model.model'], 'local');
    const shownA = await client.request('config.get', {});
    assert.equal(shownA.model.model, undefined, 'A 那一格没写：读自己那两层，不拿 B 的那一份来说');

    const written = await client.request('config.set', { field: 'model.model', value: 'B 改过的', layer: 'projectLocal', version: shownB.layers[1].version, projectRoot: b });
    assert.deepEqual(written.applies.map((item) => item.sessionId), [inB.sessionId], '只有 B 的会话采用它');
    assert.ok((await readFile(join(b, '.ligule', 'config.local.toml'), 'utf8')).includes('B 改过的'));
    await assert.rejects(() => stat(join(a, '.ligule', 'config.local.toml')), 'A 的那一份文件没被这次写出来');
    assert.equal((await client.request('status.get', { sessionId: inA.sessionId })).model, 'test-model', 'A 的会话打的东西没被这一次带动');

    // 使用者默认那一层是所有项目共用的：A 折得到它，B 自己被本机覆盖那一层盖着，所以只有 A 采用（D8 的层序）。
    const saved = await client.request('config.set', { field: 'model.model', value: '共用默认', layer: 'user', version: shownB.layers[0].version });
    assert.deepEqual(saved.applies.map((item) => item.sessionId), [inA.sessionId], 'B 那一格由本机覆盖写着，低一层的默认盖不过它');
    assert.equal((await client.request('status.get', { sessionId: inA.sessionId })).model, '共用默认');
    assert.equal((await client.request('status.get', { sessionId: inB.sessionId })).model, 'B 改过的');
  } finally {
    pair.client.output.end();
    await host.release();
    await rm(root, { recursive: true, force: true });
  }
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

// 写进去的生成选择什么时候被采用（实现顺序第 91 步，方案 7.3 第二行）：空着的会话立刻换，
// 跑着的那一轮用开始时那一份，新的那一份在整轮收尾之后、下一条输入受理之前采用。
test('a saved generation choice lands now on an idle session and at the round edge on a running one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-generation-'));
  const home = join(root, 'home');
  const userFile = join(home, '.ligule', 'config.toml');
  await mkdir(dirname(userFile), { recursive: true });
  await writeFile(userFile, '[model]\napi = "messages"\nbaseURL = "http://127.0.0.1:1"\nmodel = "装配时那一份"\n', 'utf8');
  const store = createConfigStore({ projectRoot: root, userHome: home });
  const served = [];
  let gate;
  const deriveProvider = (config) => ({
    model: config.model.model,
    capabilities: MESSAGES_CAPABILITIES,
    async *stream() {
      if (gate !== undefined) await gate;
      served.push(config.model.model);
      yield { type: 'text', text: '一份回答' };
    },
  });
  try {
    await withInProcessHost(async (connection) => {
      const { sessionId } = await connection.request('session.create', {});
      const version = (await connection.request('config.get', {})).layers[0].version;

      // 空着的那一份：写完就走新读回来的那一条提供方。
      const idle = await connection.request('config.set', { field: 'model.model', value: '第一份', layer: 'user', version });
      assert.deepEqual(idle.applies, [{ sessionId, when: 'now' }]);
      const now = await connection.request('status.get', { sessionId });
      assert.equal(now.model, '第一份', '状态里读得出这一份会话现在打的是哪一份模型');
      assert.equal(now.pendingModel, null, '没有等着换的那一份时那一格是空的');
      await connection.request('run.start', { sessionId, input: '甲' });
      assert.deepEqual(served, ['第一份'], '下一轮走的是刚写进去的那一份，不是装配时那一份');

      // 跑着的那一轮里保存：本轮的每一次调用都还是开始时那一份，换的那一次落在轮的边界上。
      let release;
      gate = new Promise((resolve) => { release = resolve; });
      const running = connection.request('run.start', { sessionId, input: '乙' });
      await delay(60);
      const again = await connection.request('config.set', {
        field: 'model.model', value: '第二份', layer: 'user', version: (await connection.request('config.get', {})).layers[0].version,
      });
      assert.deepEqual(again.applies, [{ sessionId, when: 'round' }]);
      const waiting = await connection.request('status.get', { sessionId });
      assert.equal(waiting.model, '第一份', '那一轮还在走开始时那一份');
      assert.equal(waiting.pendingModel, '第二份', '等在它轮次边界上的那一份读得出来');
      release();
      gate = undefined;
      await running;
      assert.deepEqual(served, ['第一份', '第一份'], '那一轮里两次调用用的都是开始时那一份');
      await connection.request('run.start', { sessionId, input: '丙' });
      assert.deepEqual(served.at(-1), '第二份', '边界之后才换');

      // 晚开的会话继承最近写进去的那一份，不是装配那一次的那一份。
      const other = await connection.request('session.create', {});
      assert.equal((await connection.request('status.get', { sessionId: other.sessionId })).model, '第二份');

      // 文件已经写对、提供方重算失败：那两件事分开说，界面才写得出「已保存 / 未生效」。
      const broken = await connection.request('config.set', {
        field: 'model.model', value: 'deriveProvider 认不下的那一份', layer: 'user', version: (await connection.request('config.get', {})).layers[0].version,
      });
      assert.ok(broken.version, '文件那一次是写成了');
      assert.deepEqual(broken.applies, [], '但没有任何一份会话采用了它');
      assert.equal(broken.failure.code, 'provider_rebuild_failed', '失败那一侧说的是重算提供方这件事，不是保存失败');
      await connection.request('run.start', { sessionId, input: '丁' });
      assert.deepEqual(served.at(-1), '第二份', '重算失败不改已经在走的那一份');
    }, undefined, { configStore: store, deriveProvider: (config) => {
      if (config.model.model === 'deriveProvider 认不下的那一份') throw new Error('that shape is not known');
      return deriveProvider(config);
    } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
// 那一个项目的记录目录里，那一个项目的列表才列得出它。装载不出别的项目环境的宿主直接说不支持。
// 项目根自己不存在、是文件、读不动各给一个稳定码；有效项目没有记录目录时交回空列表（方案 2A）。
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

    // 接开已经在这具宿主里的那一份不用再指名项目：它读自己那一份项目环境（桌面对刚在别项目录里建好的那一份只带编号去接那一条路）。
    assert.deepEqual(await client.request('session.open', { sessionId: inSecond.sessionId }), { sessionId: inSecond.sessionId });

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

    // 项目根自己那三种情形各给一个稳定码（方案 2A）：不存在、是文件、以及有效但还没有记录目录。
    await assert.rejects(
      client.request('sessions.list', { projectRoot: join(root, 'never-created') }),
      (error) => error.code === 'host_project_root_missing',
      '这一条路不存在说出来，不把它当成一份没有会话的项目',
    );
    // 开会话也走同一处分类：拒绝发生在装载之前，记录那一路的建目录（`src/session/session.js`）就不会把拼错的那一条路建出来。
    await assert.rejects(
      client.request('session.create', { projectRoot: join(root, 'never-created') }),
      (error) => error.code === 'host_project_root_missing',
      '拼错的项目根开不成会话',
    );
    assert.equal(await stat(join(root, 'never-created')).then(() => 'created', (error) => error.code), 'ENOENT',
      '被拒绝的那一次没有留下任何目录');
    await writeFile(join(root, 'a-file.txt'), 'x');
    await assert.rejects(
      client.request('sessions.list', { projectRoot: join(root, 'a-file.txt') }),
      (error) => error.code === 'host_project_root_not_directory',
      '那一条路是文件：说的不是「不存在」',
    );
    // 那一条路下面还有一段时，两边走的写法不同：Windows 上 `stat` 报 ENOENT，POSIX 上报 ENOTDIR（2026-10-08 在本机探针复测）。
    // 两种都算「这一条路不是一个能打开的目录」，具体是哪一个由那台机器说。
    const nested = await client.request('sessions.list', { projectRoot: join(root, 'a-file.txt', 'nested') })
      .then(() => 'resolved', (error) => error.code);
    assert.ok(nested === 'host_project_root_missing' || nested === 'host_project_root_not_directory',
      `路上有一段是文件时要说出来，实际是 ${nested}`);
    const empty = join(root, 'third');
    await mkdir(empty, { recursive: true });
    assert.deepEqual((await client.request('sessions.list', { projectRoot: empty })).sessions, [],
      '有效项目还没跑过任何一轮时交回空列表：记录目录不存在不是错误（参照 E09）');
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

// 跑着的那一轮不该挡住「看一眼这一份会话」（审阅 F4）：桌面切换会话先要接住这一份，接不上就连那一屏的记录也读不到。
// 这一条只看不改：不重装配、不收线，也不把这一轮打断。
test('opening a session that is already open and running is a read, not an interruption', async () => {
  await withInProcessHost(async (connection, { hold }) => {
    const { sessionId } = await connection.request('session.create', {});
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    hold(gate);
    const running = connection.request('run.start', { sessionId, input: '慢一点' });
    await delay(50);
    assert.deepEqual(await connection.request('session.open', { sessionId }), { sessionId }, '接回来这一份是成立的：它没被打断，也没换装配');
    const read = await connection.request('session.read', { sessionId });
    assert.ok(read.events.some((event) => event.kind === 'user'), '正在跑的那一句已经在记录里，画面读得到');
    assert.equal((await connection.request('status.get', { sessionId })).running, true, '这一轮还在跑');
    release(undefined);
    assert.ok((await running).iterations >= 1, '这一轮自己走完了');
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

// 分支（实现顺序第 80 步，方案 4.3）：复制一段前缀成新会话，父那一份不动。
test('branching a session copies a prefix and leaves the parent record alone', async () => {
  await withInProcessHost(async (connection) => {
    const { sessionId } = await connection.request('session.create', {});
    await connection.request('run.start', { sessionId, input: '说一句' });
    const record = await connection.request('session.read', { sessionId });
    const marker = record.events.find((event) => event.kind === 'turn');
    assert.ok(marker !== undefined, '一轮正常收尾留下一条可选的轮次标记（第 68 步）');

    const branched = await connection.request('session.branch', { sessionId, at: marker.seq });
    assert.deepEqual([branched.parentSessionId, branched.at], [sessionId, marker.seq], '交回的是新会话与它停在哪一条');
    const opened = await connection.request('session.open', { sessionId: branched.sessionId });
    const copied = await connection.request('session.read', { sessionId: opened.sessionId });
    assert.deepEqual(copied.events.map((event) => event.seq), record.events.filter((event) => event.seq <= marker.seq).map((event) => event.seq),
      '分支那份就是那一段前缀，序号接着父那一份');
    assert.ok((await connection.request('sessions.list', {})).sessions.some((item) => item.id === branched.sessionId),
      '写完才出现在列表里');

    const after = await connection.request('session.read', { sessionId });
    assert.deepEqual(after.events, record.events, '父那一份一个字没动');
    await connection.request('session.close', { sessionId: opened.sessionId });
  });
});

// `paths.list`（实现顺序第 85 步，方案 5.3）：候选由宿主列出来，界面不开盘。
// 交回的是边界内的相对路径；`.git` 与 `node_modules` 不进候选，符号链接既不跟也不列，条数有上限。
test('the host lists project files for an interface without exposing links or noise', async () => {
  await withInProcessHost(async (connection, { directory }) => {
    await mkdir(join(directory, 'notes'), { recursive: true });
    await mkdir(join(directory, '.git'), { recursive: true });
    await mkdir(join(directory, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(directory, 'notes', 'Readings Old.md'), 'x');
    await writeFile(join(directory, 'notes', 'readings-3.md'), 'x');
    await writeFile(join(directory, 'notes', '读数 第三版.md'), 'x');
    await writeFile(join(directory, '.git', 'config'), 'x');
    await writeFile(join(directory, 'node_modules', 'pkg', 'index.js'), 'x');
    // Windows 上建符号链接要开发者模式：建不出来就跳过那一段断言，不把它算成通过。
    let linked = false;
    try {
      await symlink(join(directory, 'notes', 'readings-3.md'), join(directory, 'notes', 'inside-link.md'));
      linked = true;
    } catch {
      linked = false;
    }

    const listed = await connection.request('paths.list', { query: 'readings' });
    assert.deepEqual(listed.paths, ['notes/Readings Old.md', 'notes/readings-3.md'], '大小写不分，交回的是斜杠书写的相对路径');
    assert.equal(listed.projectRoot, directory, '交回的是列的哪一个项目');
    assert.equal(listed.stopped, '', '这一份小目录翻得完，不说「可能没找全」');
    assert.equal((await connection.request('paths.list', { query: 'config' })).paths.length, 0, '.git 里的东西不进候选');
    assert.equal((await connection.request('paths.list', { query: 'index.js' })).paths.length, 0, 'node_modules 里的东西不进候选');
    if (linked) assert.equal((await connection.request('paths.list', { query: 'inside-link' })).paths.length, 0,
      '符号链接既不跟也不列：指向边界之内也一样不替人决定那一条路通向哪里');

    assert.deepEqual((await connection.request('paths.list', { query: '读数' })).paths, ['notes/读数 第三版.md'],
      '中文与带空格的文件名照原样交回：路径里那一个空格不改写成别的形状');
    const capped = await connection.request('paths.list', { query: '', limit: 1 });
    assert.equal(capped.paths.length, 1, '一次最多交 `limit` 条');
    await assert.rejects(connection.request('paths.list', { projectRoot: join(directory, 'nope') }),
      (error) => error.code === 'host_project_root_unsupported', '没装载过的项目根不猜边界');
  });
});

test('a file listing that ran out of its budget says so instead of finding nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-paths-budget-'));
  try {
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) await writeFile(join(directory, name), 'x');
    const partial = await listProjectFiles(directory, 'zzz', 20, 2);
    assert.equal(partial.visited, 2, '翻到那一个上限就停手');
    assert.equal(partial.stopped, 'budget', '一条没找到也要说这份清单不一定全：人据此改字重问，不会把没翻完当成项目里没有');
    const complete = await listProjectFiles(directory, 'zzz', 20, 99);
    assert.deepEqual(complete.paths, [], '整棵翻完时才说没有对得上的');
    assert.equal(complete.stopped, '', '整棵翻完时不说「可能没找全」');
  } finally {
    // Windows 上刚退出的子进程那一份工作目录句柄不一定立刻放掉：删不动时重试一小段，别把 EBUSY 报成测试失败。
    for (let tries = 0; tries < 40; tries += 1) {
      try {
        await rm(directory, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code !== 'EBUSY') throw error;
        await delay(50);
      }
    }
  }
});

// 审批档位是两件：配置那一份默认与这一份会话的覆盖（D101）。
test('a session overrides the approval tier without touching the settings file', async () => {
  await withInProcessHost(async (connection) => {
    const { sessionId } = await connection.request('session.create', {});
    const before = await connection.request('status.get', { sessionId });
    assert.equal(before.policySource, 'config', '刚开起来的会话用的是配置那一份');
    const switched = await connection.request('policy.set', { sessionId, mode: 'auto' });
    assert.equal(switched.policy, 'auto');
    assert.equal(switched.policySource, 'session');
    assert.equal(switched.policyDefault, before.policy, '交回的是配置里那一份默认，界面上才有「退回」可说');
    const after = await connection.request('status.get', { sessionId });
    assert.equal(after.policy, 'auto');
    assert.equal(after.policySource, 'session');
    const back = await connection.request('policy.set', { sessionId, mode: 'default' });
    assert.equal(back.policySource, 'config');
    assert.equal(back.policy, before.policy);
    // 覆盖只落在被指名的那一份会话上：同一具宿主里的另一份读的仍是配置那一份（D101）。
    const other = await connection.request('session.create', {});
    await connection.request('policy.set', { sessionId, mode: 'auto' });
    const aside = await connection.request('status.get', { sessionId: other.sessionId });
    assert.equal(aside.policySource, 'config', '另一份会话没有被带着改');
    assert.equal(aside.policy, before.policy);
    assert.equal((await connection.request('status.get', { sessionId })).policySource, 'session');
    await assert.rejects(
      () => connection.request('policy.set', { sessionId, mode: 'sometimes' }),
      (error) => error.code === 'policy_mode_unknown',
    );
  });
});

// 规则表整份替换（D8 的合并语义），所以 `index` 指的是写着生效那一份的那一层：往另一层加一条会写出一张只有这一条的表（D100）。
test('a rule table written by another layer refuses a write aimed at a lower one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-rules-layer-'));
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  const store = createConfigStore({
    projectRoot: root,
    userHome: home,
    layers: { project: { policy: { mode: 'ask', rules: [{ tool: 'read', decision: 'allow' }] } } },
  });
  try {
    await withInProcessHost(async (connection) => {
      const shown = await connection.request('config.get', {});
      assert.deepEqual(shown.rules, [{ tool: 'read', decision: 'allow' }]);
      assert.equal(shown.rulesSource, 'project', '生效那一份是项目共享那一层写着的');
      const [user] = shown.layers.filter((layer) => layer.layer === 'user');
      await assert.rejects(
        () => connection.request('config.set', {
          field: 'policy.rules', op: 'add', layer: 'user', version: user.version, ruleTool: 'exec', ruleDecision: 'deny',
        }),
        (error) => error.code === 'config_rules_elsewhere' && error.detail.includes('project'),
      );
      assert.equal(await readFile(join(home, '.ligule', 'config.toml'), 'utf8').catch(() => ''), '', '被拒的那一次没有写出那一份文件');
    }, undefined, { configStore: store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 方案 8.2 第五景里那条合起来读的一件事：换一具宿主接回同一份会话，那一次工具调用的整段正文（写在溢出文件里）
// 与它自己的实际耗时都要照原样读回来，新一轮也不改写上一轮那两条。
// 上一版在一趟里交替起落两具子进程宿主，重复跑到第三遍时工作进程静默断在十条之后；这一版改成按会话交锁：
// 关掉那一份会话就把写锁交了（第 70 步那一条），不必在一趟里停掉还活着的宿主，收尾也只由助手做一次。
test('a restarted Host reads back the spilled body and the stored duration of the earlier round', async () => {
  await withHost(async (host, { directory, startAnother }) => {
    host.client.onRequest(() => ({ decision: 'allow' }));
    await writeFile(join(directory, 'note.txt'), '这一段正文要长到越过那一格上限。'.repeat(40));
    const { sessionId } = await host.client.request('session.create', {});
    await host.client.request('run.start', { sessionId, input: 'read the note' });

    const first = (await host.client.request('session.read', { sessionId, fullResults: true })).events;
    const tool = first.find((event) => event.kind === 'tool');
    assert.ok(tool !== undefined, `这一轮没留下工具结果那一条事实：${first.map((event) => event.kind).join(',')}`);
    assert.equal(typeof tool.result?.spilled, 'string', `那一次结果没走溢出文件：${String(tool.result?.content).slice(0, 80)}`);
    const stored = tool.durationMs ?? tool.result?.durationMs;
    const body = JSON.stringify(tool.result?.content ?? '');
    assert.equal(typeof stored, 'number', `那次工具调用没带上实际耗时：${body.slice(0, 200)}`);

    await host.client.request('session.close', { sessionId });
    const again = startAnother();
    try {
      again.client.onRequest(() => ({ decision: 'allow' }));
      await again.client.request('session.open', { sessionId });
      const reread = (await again.client.request('session.read', { sessionId, fullResults: true })).events.find((event) => event.kind === 'tool');
      assert.ok(JSON.stringify(reread.result?.content ?? '').includes('这一段正文要长到越过那一格上限'), `重开之后整段正文没读回来：${JSON.stringify(reread.result?.content).slice(0, 120)}`);
      assert.equal(reread.durationMs ?? reread.result?.durationMs, stored, '重开之后那次工具调用的实际耗时变了');
      await again.client.request('run.start', { sessionId, input: 'read the note again' });
      const after = (await again.client.request('session.read', { sessionId, fullResults: true })).events.find((event) => event.kind === 'tool');
      assert.equal(after.result?.spilled, tool.result.spilled, '新一轮改写了上一轮那条结果的溢出文件引用');
      assert.equal(after.durationMs ?? after.result?.durationMs, stored, '新一轮改写了上一轮那次调用的实际耗时');
    } finally {
      await stop(again);
    }
  }, ['--config', 'limits.resultBytes=48']);
});

// 两端共用的那一份输入历史走宿主这一条路（方案 5.5.6）：界面发得出自己说过的那一句、读得回整份清单，
// 但说不出那一份文件在哪一处。另一端的写法也读得到，因为读写的都是同一份文件。
test('the host keeps the input history both surfaces share: newest first, one copy per sentence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-input-history-'));
  const previous = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = join(root, 'data');
  const config = createConfig({ user: { boundary: root, model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' } } });
  const quiet = { capabilities: MESSAGES_CAPABILITIES, model: 'test-model', async *stream() { yield { type: 'text', text: 'ok' }; } };
  const pair = createMemoryConnectionPair();
  const host = serveHost({ input: pair.host.input, output: pair.host.output, config, provider: quiet, policy: { mode: 'auto' } });
  const client = createConnection(pair.client);
  try {
    assert.deepEqual((await client.request('history.read', {})).entries, [], '还没有过任何一次输入不是错误');
    assert.deepEqual((await client.request('history.append', { text: '第一句' })).entries, ['第一句']);
    assert.deepEqual((await client.request('history.append', { text: '  第二句  ' })).entries, ['第二句', '第一句'], '最新的排在最前，两头空的字去掉');
    assert.deepEqual((await client.request('history.append', { text: '第一句' })).entries, ['第一句', '第二句'], '同一句让位过来，不占两格');
    await client.request('history.append', { text: '   ' });
    assert.deepEqual((await client.request('history.read', {})).entries, ['第一句', '第二句'], '什么都没有的那一句不改这份历史');

    await rememberHistory(historyPathOf(), ['另一端写下的一句']);
    assert.deepEqual((await client.request('history.read', {})).entries, ['另一端写下的一句', '第一句', '第二句'], '两端读的是同一份文件');
    assert.ok((await readFile(join(root, 'data', 'tui-history.jsonl'), 'utf8')).split('\n')[0].includes('另一端写下的一句'));
    await assert.rejects(client.request('history.append', {}), (error) => error.code === 'protocol_args_invalid', '没有句子就没有要记的东西');
  } finally {
    pair.client.output.end();
    await host.release();
    if (previous === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

// 数据根里没有 `[model]` 那一格时，宿主这一路要起得来：桌面壳设置里那一栏正是用来写上那几格的（U59）。
// 命令行与终端那两路不当场报错就没人说这句话，所以那两路仍旧走 `providerFromConfig`。
test('the host keeps a shape to serve from when no model is configured yet', async () => {
  const pending = hostProviderFromConfig({});
  assert.equal(pending.pending, true, '缺的那几格由这一枚占位的顶着');
  assert.equal(typeof pending.stream, 'function', '宿主认的就是 `provider.stream` 是一个函数，这一枚要过得去');
  await assert.rejects(async () => {
    for await (const chunk of pending.stream({ messages: [] })) void chunk;
  }, (error) => error.code === 'host_model_config_missing', '真要发一轮时说的是缺哪几格');
  assert.throws(() => pending.withModel('deepseek-chat'), (error) => error.code === 'host_model_config_missing', '换模型也换不出一份不存在的配置');
  assert.equal(hostProviderFromConfig({ model: { api: 'other' } }).pending, true, '线上形状写错的那一种也留着让界面改得动');
  assert.throws(() => providerFromConfig({}), (error) => error.code === 'host_model_config_missing', '命令行那一路照旧当场说');
});
