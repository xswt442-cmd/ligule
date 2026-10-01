import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDecisionChain, createKernel, execTool } from '../src/index.js';

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
