import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
// 命令行按构建产物验（D47）：src/ 里有 .ts，源码那一份不能直接跑，跑起来的那一份就是发布出去的那一份。
const cli = join(repo, 'dist', 'cli.js');

function capture(...args) {
  try {
    return { ok: true, stdout: execFileSync(process.execPath, [cli, ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { ok: false, stdout: error.stdout, stderr: error.stderr, status: error.status };
  }
}

test('tools prints the eight members of the minimal manifest', () => {
  assert.deepEqual(capture('tools').stdout.trim().split('\n'), ['create', 'delete', 'edit', 'exec', 'find', 'read', 'search', 'write']);
});

test('call runs a tool in the same process and prints what it returned', () => {
  // 边界指到 src：默认边界是整个仓库，那一次遍历会走进 testplace/，
  // 而并行跑的测试正在那里建删临时目录，扫到一半目录就不在了。
  const found = capture('call', 'find', JSON.stringify({ pattern: '*.js' }), '--config', 'boundary = "src"');
  assert.ok(found.ok, found.stderr);
  assert.match(found.stdout, /^cli\.js$/m);

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

  // 站在终端前的人看的是那一句说明，不只是码（D19 把码与文本分开就是这个用意）。
  const missingFile = capture('call', 'read', JSON.stringify({ path: 'no-such-file-anywhere.txt' }));
  assert.match(missingFile.stderr, /^path_not_found: there is nothing to read at /);
});

// 打错的命令不是一次成功：帮助文本走 stdout、退出码 0，调用方是个脚本就分不出来。
test('an unknown command is a failure, while asking for help is not', () => {
  const unknown = capture('frobnicate');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /cli_command_unknown/);
  assert.equal(unknown.stdout, '');

  for (const flag of [undefined, '--help', '-h']) {
    const asked = flag === undefined ? capture() : capture(flag);
    assert.ok(asked.ok, asked.stderr);
    assert.match(asked.stdout, /commands: tools, skills, run/);
  }
});

test('--config narrows the boundary from the command line and a valueless flag is refused', () => {
  const scoped = capture('call', 'find', JSON.stringify({ pattern: '*.js' }), '--config', 'boundary = "test"');
  assert.ok(scoped.ok, scoped.stderr);
  assert.match(scoped.stdout, /^cli\.test\.js$/m);
  assert.doesNotMatch(scoped.stdout, /src/);

  const missing = capture('tools', '--config');
  assert.equal(missing.ok, false);
  assert.match(missing.stderr, /cli_config_needs_a_value/);
});

test('--version prints the package version and the bare invocation lists the commands', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.equal(capture('--version').stdout.trim(), pkg.version);
  assert.match(capture().stdout, /commands: tools, skills, run/);
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
  // 用户那一层指到临时目录：不碰真实 HOME，两个平台的取值入口都设上。
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  try {
    const listed = spawnSync(process.execPath, [cli, 'skills'], { cwd: project, encoding: 'utf8', env });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /^demo\t.*demo$/m);
    assert.match(listed.stderr, /not loaded: 1/);
    assert.match(listed.stderr, /skill_description_missing/);

    const empty = join(root, 'empty');
    mkdirSync(empty, { recursive: true });
    const none = spawnSync(process.execPath, [cli, 'skills'], { cwd: empty, encoding: 'utf8', env });
    assert.equal(none.status, 0, none.stderr);
    assert.match(none.stdout, /no skills loaded/);
    // 一份都没有时把扫过的四个位置说出来：「装了但没生效」最难自查。
    assert.match(none.stdout, /looked in .*[\\/]empty[\\/]\.ligule[\\/]/);
    assert.equal(none.stdout.split('\n').filter((line) => line.includes('looked in')).length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
