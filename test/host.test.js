// 第 14 步的验收：一个子进程经标准输入输出上的这条协议跑完一轮（D30），全程不开端口。
// 模型那一侧是本地起的真实 HTTP 服务按 SSE 一帧一帧写出去，与 test/provider.test.js 同一种测法；
// 进程、流、审批往返回与落盘的记录都是真的，没有假实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createConnection, METHODS, NOTIFICATIONS } from '../src/index.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

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
function startHost(directory, baseUrl) {
  const child = spawn(process.execPath, [
    CLI, 'host',
    '--config', `model.baseURL="${baseUrl}"`,
    '--config', 'model.model="test-model"',
    '--config', 'policy.mode="ask"',
  ], { cwd: directory, env: { ...process.env, LIGULE_API_KEY: 'test-key' } });
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

    const deltas = notifications.filter((message) => message.notify === 'delta').map((message) => message.event);
    assert.deepEqual(deltas.map((event) => event.type), ['tool-call', 'text'], 'the stream is forwarded as it arrives');
    assert.ok(notifications.every((message) => NOTIFICATIONS.includes(message.notify)), 'nothing arrives outside the names the protocol declares');
    const events = notifications.filter((message) => message.notify === 'event').map((message) => message.event);
    assert.deepEqual(events.map((event) => event.kind), ['user', 'assistant', 'tool', 'assistant']);
    assert.equal(events[2].result.content.text, 'the body', 'the tool result the client saw is the file content');

    // 客户端看见的那一条与记录里落盘的那一条同源，序号也在通知里带回来了。
    const recorded = (await readFile(join(directory, '.ligule', 'sessions', `${sessionId}.jsonl`), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(recorded.map((event) => event.seq), events.map((event) => event.seq));

    const status = await host.client.request('status.get', { sessionId });
    assert.equal(status.running, false);
    assert.equal(status.mode, 'ask');
    assert.ok(status.tools.includes('read'));
    assert.deepEqual(status.denials, { consecutive: 0, total: 0 });
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
      assert.deepEqual(reopened.events.map((event) => event.kind), ['user', 'assistant', 'tool', 'assistant']);
      assert.equal(reopened.events[2].result.content.text, 'the body');
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
      '--config', `model.baseURL="${baseUrl}"`,
      '--config', 'model.model="test-model"',
      '--config', 'policy.mode="ask"',
    ], { cwd: directory, env: { ...process.env, LIGULE_API_KEY: 'test-key' } });
    const written = { stdout: '', stderr: '' };
    for (const name of ['stdout', 'stderr']) {
      child[name].setEncoding('utf8');
      child[name].on('data', (chunk) => {
        written[name] += chunk;
        if (written.stderr.includes('[y/N]') && !child.stdin.destroyed) {
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
