import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repo, 'src', 'cli.js');

function capture(...args) {
  try {
    return { ok: true, stdout: execFileSync(process.execPath, [cli, ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { ok: false, stdout: error.stdout, stderr: error.stderr, status: error.status };
  }
}

test('tools prints the seven members of the minimal manifest', () => {
  assert.deepEqual(capture('tools').stdout.trim().split('\n'), ['create', 'delete', 'edit', 'exec', 'find', 'read', 'search']);
});

test('call runs a tool in the same process and prints what it returned', () => {
  const found = capture('call', 'find', JSON.stringify({ pattern: '**/*.js' }));
  assert.ok(found.ok);
  assert.match(found.stdout, /src\/cli\.js/);

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
});

test('--version prints the package version and the bare invocation lists the commands', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.equal(capture('--version').stdout.trim(), pkg.version);
  assert.match(capture().stdout, /commands: tools, call/);
});
