// 第 31 步的验收（D71）：派生体过同一条判定链、登记表里没有 `subagent` 自己、记录另开一份支线。
// 内核、判定链、会话记录与循环都是真的；提供方按脚本回答，因为它只负责把「下一步做什么」这件事说出来。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createConfig, createDecisionChain, createKernel, createSessionLog, createSubagentPlugin,
  minimalPlugin, networkPlugin,
} from '../dist/index.js';

const text = (value) => [
  { type: 'message_start', message: { usage: {} } },
  { type: 'text', text: value },
];
const call = (name, args) => [{ type: 'message_start', message: { usage: {} } }, { type: 'tool-call', id: `call_${name}_${Math.random().toString(36).slice(2, 6)}`, name, args }];

function scripted(turns) {
  const requests = [];
  let index = 0;
  return {
    requests,
    name: 'scripted',
    model: 'test-model',
    capabilities: {},
    async *stream(request) {
      requests.push(request);
      const events = turns[index] ?? text('nothing left to say');
      index += 1;
      for (const event of events) yield event;
    },
  };
}

// 父记录与派生记录都要真目录（记录是真的会话文件），跑完一起收掉。
const created = [];
async function tempDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  created.push(directory);
  return directory;
}
after(() => Promise.all(created.map((directory) => rm(directory, { recursive: true, force: true }))));

async function workspace() {
  const directory = await tempDirectory('ligule-subagent-');
  await writeFile(join(directory, 'note.txt'), 'the body');
  return directory;
}

test('the derived agent runs on the parent decision chain and cannot delegate again', async () => {
  const boundary = await workspace();
  const config = createConfig({ user: { boundary, limits: { execBytes: 2000 } } });
  const chain = createDecisionChain({
    mode: 'auto',
    rules: [{ tool: 'exec', decision: 'deny', match: 'rm *', reason: 'deleting through exec is not allowed' }],
  });
  const provider = scripted([
    call('subagent', { task: 'delete the thing' }),      // 父：派一块活
    call('exec', { command: 'rm -rf /tmp/nowhere' }),    // 子：想删东西，被同一条链挡下
    text('I could not delete it'),                       // 子：收口
    text('the child reported back'),                     // 父：收口
  ]);
  const session = createSessionLog({ directory: await tempDirectory('ligule-subagent-log-'), id: 'parent' });
  const kernel = createKernel({ config, policy: chain, session });
  createSubagentPlugin({
    config,
    provider,
    chain,
    prompt: { staticPrefix: 'shared static prefix' },
    directory: session.directory,
    sessionId: 'parent',
    plugins: [minimalPlugin, networkPlugin],
  }).setup(kernel);

  const result = await kernel.call('subagent', { task: 'delete the thing' });
  assert.equal(result.text, 'I could not delete it');
  assert.equal(result.sessionId, 'parent.sub-1');
  assert.equal(result.iterations >= 2, true);
  // 档位是共用的：子会话里那一次拒绝计入父链的计数（D71 第一条）。
  assert.equal(chain.denials().total >= 1, true);
  assert.equal(JSON.stringify(provider.requests[1].tools).includes('"subagent"'), false, '派生体不能再派');
  assert.ok(JSON.stringify(provider.requests[1].tools).includes('"read"'));
  assert.equal(provider.requests[1].system.startsWith('shared static prefix'), true, '静态前缀沿用父的那一份（D9）');

  const files = await readdir(session.directory);
  assert.deepEqual(files.sort(), ['parent.jsonl', 'parent.sub-1.jsonl']);
  const side = (await readFile(join(session.directory, 'parent.sub-1.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  // 支线记录也有一份首行（D73）：它说清这一份是谁的哪一次派生，读的人不必猜。
  assert.equal(side[0].kind, 'session');
  assert.equal(side[0].sessionId, 'parent.sub-1');
  const sideEvents = side.filter((event) => event.kind !== 'session');
  assert.equal(sideEvents[0].kind, 'user');
  assert.equal(sideEvents[0].text, 'delete the thing');
  const denied = sideEvents.find((event) => event.kind === 'tool' && event.tool === 'exec');
  assert.equal(denied.result.code, 'policy_denied');
  const parent = (await readFile(join(session.directory, 'parent.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const delegated = parent.find((event) => event.kind === 'tool' && event.tool === 'subagent');
  assert.equal(delegated.result.content.sessionId, 'parent.sub-1');
});

test('a task is required, and a mode is only looked up when this run has mode directories', async () => {
  const boundary = await workspace();
  const config = createConfig({ user: { boundary } });
  const chain = createDecisionChain({ mode: 'auto' });
  const session = createSessionLog({ directory: await tempDirectory('ligule-subagent-log-'), id: 'p2' });
  const kernel = createKernel({ config, policy: chain, session });
  createSubagentPlugin({
    config,
    provider: scripted([text('unused')]),
    chain,
    prompt: { staticPrefix: '' },
    directory: session.directory,
    sessionId: 'p2',
    plugins: [minimalPlugin],
  }).setup(kernel);
  await assert.rejects(
    () => kernel.call('subagent', { task: '   ' }),
    (error) => error.code === 'subagent_task_required',
  );
  await assert.rejects(
    () => kernel.call('subagent', { task: 'do it', mode: 'other' }),
    (error) => error.code === 'subagent_mode_paths_required',
  );
});

// 父会话选了哪一份模式，派生体就在那一份下跑（D71 的档位继承也包括这一格）：藏起来的工具它同样看不见。
test("the derived agent runs under the mode the parent session picked", async () => {
  const boundary = await workspace();
  const config = createConfig({ user: { boundary } });
  const chain = createDecisionChain({ mode: 'auto' });
  const provider = scripted([
    call('subagent', { task: 'read only' }),
    text('read it'),
    text('back to the parent'),
  ]);
  const session = createSessionLog({ directory: await tempDirectory('ligule-subagent-log-'), id: 'p3' });
  const kernel = createKernel({ config, policy: chain, session });
  createSubagentPlugin({
    config,
    provider,
    chain,
    prompt: { staticPrefix: '' },
    directory: session.directory,
    sessionId: 'p3',
    plugins: [minimalPlugin, networkPlugin],
    modeFile: () => ({ name: 'readonly', layer: 'user', path: 'readonly.toml', tools: ['read'], prompt: [] }),
  }).setup(kernel);
  const result = await kernel.call('subagent', { task: 'read only' });
  assert.equal(result.mode, 'readonly');
  assert.deepEqual(provider.requests[1].tools.map((entry) => entry.name), ['read']);
});
