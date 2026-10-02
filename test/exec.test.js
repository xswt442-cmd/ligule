import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDecisionChain, createKernel, execTool } from '../src/index.js';
import { decode } from '../src/capability/exec.js';

const node = `"${process.execPath}"`;

function run(command, limits, signal) {
  return execTool.run({ command }, { config: { boundary: process.cwd(), limits }, signal });
}

test('exec returns the command output and its exit code', async () => {
  const result = await run(`${node} -e ${JSON.stringify("console.log('out');console.error('err');process.exit(3)")}`);
  assert.equal(result.exitCode, 3);
  assert.match(result.text, /out/);
  assert.match(result.text, /err/);
});

test('output beyond the limit keeps both ends and says how much is missing', async () => {
  const result = await run(`${node} -e ${JSON.stringify("process.stdout.write('x'.repeat(400))")}`, { execBytes: 40 });
  assert.match(result.text, /^x{20}/);
  assert.match(result.text, /\[truncated: \d+ bytes total, \d+ bytes in the middle omitted]/);
  assert.match(result.text, /x{20}$/);
});

// 不给标准输入：把父进程的那一个继承下去，等着读输入的命令就一直挂着，这一轮再也回不来。
test('the command gets no readable standard input', async () => {
  const script = "let n=0;"
    + "process.stdin.on('data',(d)=>{n+=d.length});"
    + "process.stdin.on('end',()=>{console.log('eof:' + n);process.exit(0)});"
    + "setTimeout(()=>{console.log('hang');process.exit(9)},2000)";
  const result = await run(`${node} -e ${JSON.stringify(script)}`);
  assert.equal(result.exitCode, 0, 'the command ends on its own once the input is closed');
  assert.match(result.text, /eof:0/);
  assert.doesNotMatch(result.text, /hang/);
});

// 一千万字节的输出：留下的只有头尾那一页，中间那一段既不收集也不在最后整体拼一次。
test('a large output keeps a bounded page and reports the exact arithmetic', async () => {
  const result = await run(
    `${node} -e ${JSON.stringify("for (let i = 0; i < 200; i++) process.stdout.write('y'.repeat(50000));")}`,
    { execBytes: 60 },
  );
  assert.match(result.text, /\[truncated: 10000000 bytes total, 9999940 bytes in the middle omitted]/);
  assert.match(result.text, /^y{30}/);
  assert.match(result.text, /y{30}$/);
  assert.equal(result.text.split('\n')[0], 'y'.repeat(30), 'the head is exactly the first half of the limit');
  assert.equal(result.text.split('\n').at(-1), 'y'.repeat(30), 'the tail is the rest of the limit');
  assert.equal(result.text.split('\n').length, 3, 'three lines: head, one notice, tail');
});

test('an abort terminates the command tree instead of waiting for it', async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(
    () => run(`${node} -e ${JSON.stringify('setTimeout(() => {}, 20000)')}`, undefined, controller.signal),
    (error) => error.code === 'exec_cancelled',
  );
  assert.ok(Date.now() - started < 5000, 'the cancelled call should settle long before the command would');
});

test('an empty command line and a working directory outside the boundary are rejected', async () => {
  await assert.rejects(() => run('   '), (error) => error.code === 'exec_command_required');
  await assert.rejects(
    () => execTool.run({ command: 'dir', cwd: '..' }, { config: { boundary: process.cwd() } }),
    (error) => error.code === 'path_escapes_boundary',
  );
});

test('the decision chain sees the command text before anything is spawned', async () => {
  const kernel = createKernel({
    policy: createDecisionChain({ rules: [{ tool: 'exec', decision: 'deny', match: 'rm *' }] }),
  });
  kernel.register(execTool);
  await assert.rejects(
    () => kernel.call('exec', { command: 'rm -rf /tmp/nowhere' }),
    (error) => error.code === 'policy_denied',
  );
});

// Windows 上子进程写的是控制台码页，按 utf8 硬解会得到一串乱字（界面里就是问号）。
// 这一条只在码页真是 cp936 的控制台上跑：别的码页要的标签不在 WHATWG 的编码表里，测了也不代表那台机器。
const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
const consolePage = process.platform === 'win32'
  ? /(\d+)/.exec(execFileSync('chcp.com', [], { encoding: 'utf8' }))?.[1]
  : undefined;

test('a child writing the console code page is decoded instead of garbled', {
  skip: consolePage === '936' ? false : `needs a cp936 console (this one: ${consolePage ?? process.platform})`,
}, () => {
  assert.equal(decode(GBK_ZHONGWEN), '中文');
  assert.equal(decode(Buffer.from('普通的 utf8 输出', 'utf8')), '普通的 utf8 输出');
});
