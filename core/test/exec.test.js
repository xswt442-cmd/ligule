import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createDecisionChain, createConfig, createKernel, createPermissionContext, createSessionLog,
  execTool, resolveShell, withNativeExitCode,
} from '../dist/index.js';
import { decode } from '../dist/capability/exec.js';
import { bindScript } from '../dist/capability/script-binding.js';
import { probeLinuxSandboxIsolation } from '../dist/capability/sandbox-linux.js';

// Host 选择命令后端并传入这里；测试使用当前机器实际支持的后端。
// 被测的是 exec 自己的那几件事（头尾分页、标准输入、取消、退出码），所以脚本片段落到一个临时文件里再跑：
// Windows PowerShell 5.1 把传给原生命令的引号参数重排过一次，`<`、`>` 与 `=>` 都会被截掉（本机 2026-10-03 实测），
// 那段文本能不能原样送到 node 手上是 PowerShell 的事情，不是这一件工具的事情。斜杠两种 shell 都认，路径统一写成正斜杠。
// 命令写成 `node "<脚本>"` 这种一条简单原生命令的形状，退出码那一段尾巴才按内核那一条规则补得上。
const shell = resolveShell({});
const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});
const directory = mkdtempSync(join(tmpdir(), 'ligule-exec-'));
// 这一份跑完就收掉：留在系统临时目录里的话，每跑一次 `npm test` 就多一份，几十次之后没人会再去清。
after(() => rmSync(directory, { recursive: true, force: true }));
let counter = 0;
function nodeCommand(code) {
  const script = join(directory, `case-${(counter += 1)}.js`).replace(/\\/g, '/');
  writeFileSync(script, code);
  return `node "${script}"`;
}

async function run(command, limits, signal, permission = fullAccess) {
  const boundary = process.cwd();
  const scriptBinding = await bindScript({ command, shell, boundary, workspaceRoot: boundary, cwd: boundary, permission });
  return execTool.run({ command }, {
    config: { boundary, limits }, permission, signal,
    shell: withNativeExitCode(shell, command),
    ...(scriptBinding === undefined ? {} : { scriptBinding }),
  });
}

function processIsRunning(pid) {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function assertStopped(pid) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return;
    await delay(20);
  }
  assert.fail(`test-owned descendant process ${pid} remained alive`);
}

test('exec returns the command output and its exit code', async () => {
  const result = await run(nodeCommand('console.log("out");console.error("err");process.exit(3)'));
  assert.equal(result.exitCode, 3);
  assert.match(result.text, /out/);
  assert.match(result.text, /err/);
});

test('output beyond the limit keeps both ends and says how much is missing', async () => {
  const result = await run(nodeCommand('process.stdout.write("x".repeat(400))'), { execBytes: 40 });
  assert.match(result.text, /^x{20}/);
  assert.match(result.text, /\[truncated: \d+ bytes total, \d+ bytes in the middle omitted]/);
  assert.match(result.text, /x{20}$/);
});

// 不给标准输入：把父进程的那一个继承下去，等着读输入的命令就一直挂着，这一轮再也回不来。
test('the command gets no readable standard input', async () => {
  const script = 'let n=0;'
    + 'process.stdin.on("data",(d)=>{n+=d.length});'
    + 'process.stdin.on("end",()=>{console.log("eof:" + n);process.exit(0)});'
    + 'setTimeout(()=>{console.log("hang");process.exit(9)},2000)';
  const result = await run(nodeCommand(script));
  assert.equal(result.exitCode, 0, 'the command ends on its own once the input is closed');
  assert.match(result.text, /eof:0/);
  assert.doesNotMatch(result.text, /hang/);
});

// 一千万字节的输出：留下的只有头尾那一页，中间那一段既不收集也不在最后整体拼一次。
test('a large output keeps a bounded page and reports the exact arithmetic', async () => {
  const result = await run(
    nodeCommand('for (let i = 0; i < 200; i++) process.stdout.write("y".repeat(50000));'),
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
    () => run(nodeCommand('setTimeout(() => {}, 20000)'), undefined, controller.signal),
    (error) => error.code === 'exec_cancelled',
  );
  assert.ok(Date.now() - started < 5000, 'the cancelled call should settle long before the command would');
});

test('the configured execution timeout terminates a command with a distinct error code', async () => {
  const started = Date.now();
  await assert.rejects(
    () => run(nodeCommand('setTimeout(() => {}, 20000)'), { execTimeoutMs: 150 }),
    (error) => error.code === 'exec_timeout',
  );
  assert.ok(Date.now() - started < 5000, 'the timeout should settle long before the command would');
});

test('execution timeout configuration stays within its fixed bound', async () => {
  await assert.rejects(
    () => run(nodeCommand('console.log("unused")'), { execTimeoutMs: 0 }),
    (error) => error.code === 'exec_timeout_invalid',
  );
  await assert.rejects(
    () => run(nodeCommand('console.log("unused")'), { execTimeoutMs: 600_001 }),
    (error) => error.code === 'exec_timeout_invalid',
  );
  await assert.rejects(
    () => run(nodeCommand('console.log("unused")'), { execTimeoutMs: null }),
    (error) => error.code === 'exec_timeout_invalid',
  );
});

test('the execution layer fails closed when permission or an enforcing backend is unavailable', async () => {
  await assert.rejects(
    () => execTool.run({ command: 'node -e "process.exit(0)"' }, {
      config: { boundary: process.cwd() }, shell,
    }),
    (error) => error.code === 'exec_permission_required',
  );
  const networkLimitedFullAccess = createPermissionContext('full-access', 'policy', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  await assert.rejects(
    () => run(nodeCommand('console.log("unused")'), undefined, undefined, networkLimitedFullAccess),
    (error) => error.code === 'permission_network_isolation_unavailable',
  );
  const workspaceWrite = createPermissionContext('workspace-write', 'disabled', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  await assert.rejects(
    () => run('node --version', undefined, undefined, workspaceWrite),
    (error) => error.code === 'permission_sandbox_unavailable',
  );
});

test('Linux read-only Shell runs under bubblewrap and cannot write to its workspace', {
  skip: process.platform === 'linux' ? false : 'requires the Linux bubblewrap backend',
}, async (t) => {
  const probe = await probeLinuxSandboxIsolation();
  if (!probe.available) return t.skip(probe.reason);

  const workspace = mkdtempSync(join(directory, 'read-only-sandbox-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const command = 'printf restricted-ok; if touch denied; then exit 18; fi';
  const permission = createPermissionContext('read-only', 'disabled', {
    filesystemRead: 'partial', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  const result = await execTool.run({ command }, {
    config: { boundary: workspace }, permission,
    shell: withNativeExitCode(shell, command),
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.text, /restricted-ok/u);
  assert.equal(existsSync(join(workspace, 'denied')), false);
});

test('the child receives approved environment variables without provider secrets', async () => {
  const secretName = 'LIGULE_EXEC_TEST_PROVIDER_SECRET';
  process.env[secretName] = 'exec-test-secret-sentinel';
  try {
    const result = await run(nodeCommand(`console.log(process.env[${JSON.stringify(secretName)}] ?? 'not-inherited')`));
    assert.equal(result.text.trim(), 'not-inherited');
  } finally {
    delete process.env[secretName];
  }
});

test('timeout terminates a detached descendant without leaving it alive', async () => {
  const childPidFile = join(directory, `child-${(counter += 1)}.pid`).replace(/\\/g, '/');
  const script = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
    `writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('');
  await assert.rejects(
    () => run(nodeCommand(script), { execTimeoutMs: 3_000 }),
    (error) => error.code === 'exec_timeout',
  );
  const pid = Number(readFileSync(childPidFile, 'utf8'));
  await assertStopped(pid);
});

test('cancellation terminates a detached descendant without leaving it alive', async () => {
  const childPidFile = join(directory, `cancel-child-${(counter += 1)}.pid`).replace(/\\/g, '/');
  const script = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
    `writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('');
  const controller = new AbortController();
  const execution = run(nodeCommand(script), undefined, controller.signal);
  try {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !existsSync(childPidFile)) await delay(10);
    assert.ok(existsSync(childPidFile), 'the command should record its owned child PID before cancellation');
    const pid = Number(readFileSync(childPidFile, 'utf8'));
    controller.abort();
    await assert.rejects(() => execution, (error) => error.code === 'exec_cancelled');
    await assertStopped(pid);
  } finally {
    controller.abort();
    await execution.catch(() => undefined);
  }
});

test('an empty command line and a working directory outside the boundary are rejected', async () => {
  await assert.rejects(() => run('   '), (error) => error.code === 'exec_command_required');
  await assert.rejects(
    () => execTool.run({ command: 'dir', cwd: '..' }, { config: { boundary: process.cwd() }, permission: fullAccess, shell }),
    (error) => error.code === 'path_escapes_boundary',
  );
});

test('the decision chain sees the command text before anything is spawned', async () => {
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    permission: fullAccess,
    policy: createDecisionChain({ rules: [{ tool: 'exec', decision: 'deny', match: 'rm *' }] }),
  });
  kernel.register(execTool);
  await assert.rejects(
    () => kernel.call('exec', { command: 'rm -rf /tmp/nowhere' }),
    (error) => error.code === 'policy_denied',
  );
});

// 记录应说明使用的语法、启动的可执行文件，以及命令解析出的各段参数。
test('the record names the backend a command was judged and run under', async () => {
  const session = createSessionLog({ directory: mkdtempSync(join(directory, 'record-')), id: 'backend' });
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    permission: fullAccess,
    policy: createDecisionChain({ mode: 'auto' }),
    session,
  });
  kernel.register(execTool);
  await kernel.call('exec', { command: 'git status' });
  const [entry] = await session.read();
  // 尾巴补没补由这台机器的 PATH 决定（`git` 是个可执行文件才补），两种都在这一条里接受，但不接受第三种值。
  const { tail, ...chosen } = entry.shell;
  assert.deepEqual(chosen, { kind: shell.kind, executable: shell.executable, segments: ['git status'] });
  assert.ok(tail === undefined || tail === '; exit $LASTEXITCODE', `unexpected tail: ${tail}`);
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
