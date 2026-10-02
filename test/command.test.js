import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/index.js';

test('a simple command is one segment and the safe operators split it into several', () => {
  assert.deepEqual(parseCommand('git status'), { kind: 'segments', segments: ['git status'] });
  assert.deepEqual(parseCommand('git status | grep x'), { kind: 'segments', segments: ['git status', 'grep x'] });
  assert.deepEqual(parseCommand('rm -rf /tmp/x && echo ok'), { kind: 'segments', segments: ['rm -rf /tmp/x', 'echo ok'] });
  assert.deepEqual(parseCommand('ls; pwd'), { kind: 'segments', segments: ['ls', 'pwd'] });
});

test('an operator inside a quoted argument does not split the command', () => {
  // 这一条是按语法解析而不是按字符切分才拿得到的：正则会在引号里那个竖线上切错。
  assert.deepEqual(parseCommand('git commit -m "a | b"'), { kind: 'segments', segments: ['git commit -m "a | b"'] });
});

test('a construct outside the supported subset is reported by name', () => {
  assert.deepEqual(parseCommand('echo $(whoami)'), { kind: 'unsupported', construct: 'command_substitution' });
  assert.deepEqual(parseCommand('cat < /etc/hosts'), { kind: 'unsupported', construct: 'redirected_statement' });
  assert.deepEqual(parseCommand('echo $HOME'), { kind: 'unsupported', construct: 'simple_expansion' });
  assert.deepEqual(parseCommand('for f in *; do echo "$f"; done'), { kind: 'unsupported', construct: 'for_statement' });
});

test('a command that does not parse, and one that is empty, are both reported', () => {
  assert.deepEqual(parseCommand('not bash at all (((('), { kind: 'unsupported', construct: 'a syntax error' });
  assert.deepEqual(parseCommand('   '), { kind: 'unsupported', construct: 'no command' });
});

test('an interpreter wrapper stays one segment: the shell is not unwrapped', () => {
  assert.deepEqual(parseCommand('bash -lc "git status"'), { kind: 'segments', segments: ['bash -lc "git status"'] });
});
