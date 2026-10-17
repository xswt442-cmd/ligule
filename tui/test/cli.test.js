import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
// 命令行测试运行构建产物，验证用户实际安装后使用的入口。
const cli = join(repo, 'dist', 'cli.js');

// 子进程会读取用户级配置。使用空的临时主目录，避免本机的 `model.apiKeyEnv` 覆盖测试凭据并影响结果。
const isolatedHome = mkdtempSync(join(tmpdir(), 'ligule-cli-home-'));
const childEnv = { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome };
after(() => rmSync(isolatedHome, { recursive: true, force: true }));

function capture(...args) {
  try {
    return { ok: true, stdout: execFileSync(process.execPath, [cli, ...args], { cwd: repo, encoding: 'utf8', env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { ok: false, stdout: error.stdout, stderr: error.stderr, status: error.status };
  }
}

test('tools prints the members of the minimal manifest plus the first-party optional tools', () => {
  assert.deepEqual(capture('tools').stdout.trim().split('\n'), ['create', 'delete', 'edit', 'exec', 'fetch', 'find', 'read', 'search', 'write']);
});

test('call runs a tool in the same process and prints what it returned', () => {
  // 将文件边界限制在 src，避免默认扫描整个仓库时碰到其他并行测试创建或删除的临时目录。
  const found = capture('call', 'find', JSON.stringify({ pattern: '*.ts', path: 'src' }), '--config', 'boundary = "src"');
  assert.ok(found.ok, found.stderr);
  assert.match(found.stdout, /^cli\.ts$/m);

  const read = capture('call', 'read', JSON.stringify({ path: 'package.json' }));
  assert.ok(read.ok);
  assert.match(read.stdout, /"name": "ligule"/);
});

test('a failure prints its stable code on stderr and exits non-zero', () => {
  const missing = capture('call', 'no-such-tool', '{}');
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /tool_not_found/);

  const badJson = capture('call', 'read', 'not json');
  assert.match(badJson.stderr, /cli_args_invalid_json/);

  const noName = capture('call');
  assert.match(noName.stderr, /cli_call_needs_a_tool_name/);

  // 同时检查面向用户的错误说明和稳定错误码。
  const missingFile = capture('call', 'read', JSON.stringify({ path: 'no-such-file-anywhere.txt' }));
  assert.match(missingFile.stderr, /^path_not_found: there is nothing to read at /);
});

// 未知命令应返回非零退出码，供终端用户和调用脚本识别错误。
test('an unknown command fails, while explicit help remains available', () => {
  const unknown = capture('frobnicate');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /cli_command_unknown/);
  assert.equal(unknown.stdout, '');

  for (const flag of ['--help', '-h']) {
    const asked = capture(flag);
    assert.ok(asked.ok, asked.stderr);
    assert.match(asked.stdout, /(?:Commands: tools, skills, extensions, sessions|命令：tools、skills、extensions、sessions)/);
  }
});

test('a bare invocation and the explicit tui alias both require an interactive terminal', () => {
  for (const args of [[], ['tui']]) {
    const result = capture(...args);
    assert.equal(result.ok, false);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /tui_terminal_required/);
  }
});

test('--config narrows the boundary from the command line and a valueless flag is refused', () => {
  const scoped = capture('call', 'find', JSON.stringify({ pattern: '*.js', path: 'test' }), '--config', 'boundary = "test"');
  assert.ok(scoped.ok, scoped.stderr);
  assert.match(scoped.stdout, /^cli\.test\.js$/m);
  assert.doesNotMatch(scoped.stdout, /src/);

  const missing = capture('tools', '--config');
  assert.equal(missing.ok, false);
  assert.match(missing.stderr, /cli_config_needs_a_value/);
});

test('--version prints the package version and --help lists the commands', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.equal(capture('--version').stdout.trim(), pkg.version);
  assert.match(capture('--help').stdout, /(?:Commands: tools, skills, extensions, sessions|命令：tools、skills、extensions、sessions)/);
});

test('--lang selects help text without requiring a model configuration', () => {
  const english = capture('--help', '--lang', 'en');
  assert.equal(english.ok, true, english.stderr);
  assert.match(english.stdout, /Commands: tools/);
  assert.match(english.stdout, /Run ligule without a command to open the terminal UI/);
  assert.match(english.stdout, /--lang <zh\|en\|auto>/);

  const chinese = capture('--help', '--lang', 'zh');
  assert.equal(chinese.ok, true, chinese.stderr);
  assert.match(chinese.stdout, /命令：tools/);
  assert.match(chinese.stdout, /直接运行 ligule 打开终端界面/);
  assert.match(chinese.stdout, /选项：/);

  const simplifiedChineseAlias = capture('--help', '--lang', 'zh-CN');
  assert.equal(simplifiedChineseAlias.ok, true, simplifiedChineseAlias.stderr);
  assert.match(simplifiedChineseAlias.stdout, /命令：/);

  const invalid = capture('--help', '--lang', 'fr');
  assert.equal(invalid.ok, false);
  assert.match(invalid.stderr, /language_invalid/);
  assert.match(invalid.stderr, /--lang (?:accepts only zh, en, or auto|只接受 zh、en 或 auto)/);

  const missing = capture('--lang');
  assert.equal(missing.ok, false);
  assert.match(missing.stderr, /language_invalid: --lang (?:needs zh, en, or auto|需要 zh、en 或 auto)/);
});

test('ui.language selects CLI text and --lang overrides it', () => {
  const configured = capture('--help', '--config', 'ui.language = "zh-CN"');
  assert.equal(configured.ok, true, configured.stderr);
  assert.match(configured.stdout, /命令：/);

  const overridden = capture('--help', '--config', 'ui.language = "zh-CN"', '--lang', 'en');
  assert.equal(overridden.ok, true, overridden.stderr);
  assert.match(overridden.stdout, /Commands: tools/);
  assert.doesNotMatch(overridden.stdout, /命令：/);
});

test('CLI argument errors use the selected language and retain stable codes', () => {
  const chinese = capture('run', '--lang', 'zh');
  assert.equal(chinese.ok, false);
  assert.match(chinese.stderr, /cli_run_needs_the_user_text: run 需要用户消息/);

  const english = capture('run', '--lang', 'en');
  assert.equal(english.ok, false);
  assert.match(english.stderr, /cli_run_needs_the_user_text: run needs a user message/);
});

test('skills lists what this directory would load and says why anything was skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'ligule-cli-skills-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(join(project, '.ligule', 'skills', 'demo'), { recursive: true });
  writeFileSync(join(project, '.ligule', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: one real pack\n---\nbody\n');
  mkdirSync(join(project, '.ligule', 'skills', 'broken'), { recursive: true });
  writeFileSync(join(project, '.ligule', 'skills', 'broken', 'SKILL.md'), '---\nname: broken\n---\nbody\n');
  mkdirSync(home, { recursive: true });
  // 将 HOME 和 USERPROFILE 都指向临时目录，避免读取真实用户配置。
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  try {
    const listed = spawnSync(process.execPath, [cli, 'skills', '--lang', 'en'], { cwd: project, encoding: 'utf8', env });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /^demo\t.*demo$/m);
    assert.match(listed.stderr, /Not loaded: 1/);
    assert.match(listed.stderr, /skill_description_missing/);

    const empty = join(root, 'empty');
    mkdirSync(empty, { recursive: true });
    const none = spawnSync(process.execPath, [cli, 'skills', '--lang', 'en'], { cwd: empty, encoding: 'utf8', env });
    assert.equal(none.status, 0, none.stderr);
    assert.match(none.stdout, /No skills loaded/);
    // 未加载任何 Skill 时，列出已检查的位置，方便用户排查配置。
    assert.match(none.stdout, /Looked in .*[\\/]empty[\\/]\.ligule[\\/]/);
    assert.equal(none.stdout.split('\n').filter((line) => line.includes('Looked in')).length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 汇总结果直接读取会话记录，不需要创建内核、会话或额外计数器。
test('policy summarises the decisions one session recorded', () => {
  const root = mkdtempSync(join(tmpdir(), 'ligule-cli-policy-'));
  const project = join(root, 'project');
  const directory = join(project, '.ligule', 'sessions');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 's-1.jsonl'), [
    JSON.stringify({ kind: 'session', formatVersion: 1, sessionId: 's-1', projectRoot: project, createdAt: '2026-10-05T00:00:00.000Z' }),
    JSON.stringify({ seq: 0, kind: 'tool', tool: 'exec', verdict: { capability: 'exec', decision: 'allow', via: 'auto', level: 'auto' }, result: { failed: false, content: 'ok' } }),
    JSON.stringify({ seq: 1, kind: 'tool', tool: 'exec', verdict: { capability: 'exec', decision: 'deny', via: 'rule', level: 'auto', rule: 'rm *' }, result: { failed: true, code: 'policy_denied' } }),
  ].join('\n') + '\n');
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  try {
    const told = spawnSync(process.execPath, [cli, 'policy', 's-1', '--lang', 'zh'], { cwd: project, encoding: 'utf8', env });
    assert.equal(told.status, 0, told.stderr);
    assert.match(told.stdout, /^exec  自动 1  问过 0  拒绝 1  档位 auto×2  命中规则 "rm \*"×1  错误码 policy_denied×1$/m);

    const english = spawnSync(process.execPath, [cli, 'policy', 's-1', '--lang', 'en'], { cwd: project, encoding: 'utf8', env });
    assert.equal(english.status, 0, english.stderr);
    assert.match(english.stdout, /^exec  Automatic 1  Asked 0  Denied 1  Levels auto×2  Matched rules "rm \*"×1  Error codes policy_denied×1$/m);

    const machine = spawnSync(process.execPath, [cli, 'policy', 's-1', '--json', '--lang', 'en'], { cwd: project, encoding: 'utf8', env });
    assert.equal(machine.status, 0, machine.stderr);
    assert.equal(JSON.parse(machine.stdout)[0].denied, 1);

    for (const [args, expected] of [[['policy', 'nope'], /session_not_found/], [['policy'], /cli_policy_needs_the_session_id/]]) {
      const refused = spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: 'utf8', env });
      assert.equal(refused.status, 1, refused.stdout);
      assert.match(refused.stderr, expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 命令行和 `sessions.list` 应返回相同的会话字段，并共用同一个扫描器。
test('the printed session list is the same rows the scanner produces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ligule-cli-sessions-'));
  const directory = join(root, '.ligule', 'sessions');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 's-1.jsonl'), [
    JSON.stringify({ kind: 'session', formatVersion: 1, sessionId: 's-1', projectRoot: root, createdAt: '2026-10-05T00:00:00.000Z' }),
    JSON.stringify({ seq: 0, kind: 'user', text: 'go' }),
    JSON.stringify({ seq: 1, kind: 'assistant', text: '', toolCalls: [{ id: 'c', name: 'exec', args: { command: 'make' } }] }),
  ].join('\n') + '\n');
  try {
    const { listSessions } = await import('../dist/index.js');
    const printed = capture('sessions', '--json', '--project', root);
    assert.equal(printed.ok, true, printed.stderr);
    assert.deepEqual(JSON.parse(printed.stdout), await listSessions(directory),
      '逐字段相同，包括那条没结果的派发');
    assert.equal(JSON.parse(printed.stdout)[0].unanswered, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
