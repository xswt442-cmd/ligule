import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../dist/index.js';

test('a simple command is one segment and the safe operators split it into several', async () => {
  assert.deepEqual(await parseCommand('git status'), { kind: 'segments', segments: ['git status'] });
  assert.deepEqual(await parseCommand('git status | grep x'), { kind: 'segments', segments: ['git status', 'grep x'] });
  assert.deepEqual(await parseCommand('rm -rf /tmp/x && echo ok'), { kind: 'segments', segments: ['rm -rf /tmp/x', 'echo ok'] });
  assert.deepEqual(await parseCommand('ls; pwd'), { kind: 'segments', segments: ['ls', 'pwd'] });
});

test('an operator inside a quoted argument does not split the command', async () => {
  // 这一条是按语法解析而不是按字符切分才拿得到的：正则会在引号里那个竖线上切错。
  assert.deepEqual(await parseCommand('git commit -m "a | b"'), { kind: 'segments', segments: ['git commit -m "a | b"'] });
});

test('a construct outside the supported subset is reported by name', async () => {
  assert.deepEqual(await parseCommand('echo $(whoami)'), { kind: 'unsupported', construct: 'command_substitution' });
  assert.deepEqual(await parseCommand('cat < /etc/hosts'), { kind: 'unsupported', construct: 'redirected_statement' });
  assert.deepEqual(await parseCommand('echo $HOME'), { kind: 'unsupported', construct: 'simple_expansion' });
  assert.deepEqual(await parseCommand('for f in *; do echo "$f"; done'), { kind: 'unsupported', construct: 'for_statement' });
});

test('a command that does not parse, and one that is empty, are both reported', async () => {
  assert.deepEqual(await parseCommand('not bash at all (((('), { kind: 'unsupported', construct: 'a syntax error' });
  assert.deepEqual(await parseCommand('   '), { kind: 'unsupported', construct: 'no command' });
});

test('an interpreter wrapper stays one segment: the shell is not unwrapped', async () => {
  assert.deepEqual(await parseCommand('bash -lc "git status"'), { kind: 'segments', segments: ['bash -lc "git status"'] });
});

// PowerShell 那一档比 bash 窄（D59、D66）：只放「简单命令 + ASCII 字面参数」，管道连一条都不放。
test('the PowerShell subset takes a literal command with literal arguments', async () => {
  assert.deepEqual(await parseCommand('git status', 'powershell'), { kind: 'segments', segments: ['git status'] });
  assert.deepEqual(await parseCommand('Get-ChildItem -Recurse -Force', 'powershell'), {
    kind: 'segments',
    segments: ['Get-ChildItem -Recurse -Force'],
  });
  // `--flag=value` 在这一份 grammar 里是一个整参数，不需要先遮蔽那个等号（U35 实测的差别）。
  assert.deepEqual(await parseCommand('npm install --name=git', 'powershell'), {
    kind: 'segments',
    segments: ['npm install --name=git'],
  });
  assert.deepEqual(await parseCommand('git commit -m "plain message"', 'powershell'), {
    kind: 'segments',
    segments: ['git commit -m "plain message"'],
  });
  assert.deepEqual(await parseCommand('mkdir a; cd a', 'powershell'), { kind: 'segments', segments: ['mkdir a', 'cd a'] });
});

test('PowerShell syntax that carries meaning beyond one literal command is reported by name', async () => {
  // 管道在这一档里不是一个可以逐段判的连接符：过去的是对象，类型只有运行时知道。
  assert.deepEqual(await parseCommand('Get-Process | Stop-Process', 'powershell'), { kind: 'unsupported', construct: '|' });
  assert.deepEqual(await parseCommand('$(whoami)', 'powershell'), { kind: 'unsupported', construct: 'sub_expression' });
  assert.deepEqual(await parseCommand('{ Get-Process }', 'powershell'), { kind: 'unsupported', construct: 'script_block_expression' });
  assert.deepEqual(await parseCommand('Get-ChildItem @params', 'powershell'), { kind: 'unsupported', construct: 'variable' });
  assert.deepEqual(await parseCommand('& notepad', 'powershell'), { kind: 'unsupported', construct: 'command_invocation_operator' });
  assert.deepEqual(await parseCommand('git add . > out.txt', 'powershell'), { kind: 'unsupported', construct: 'redirection' });
  assert.deepEqual(await parseCommand('npm run build 2>&1', 'powershell'), { kind: 'unsupported', construct: 'redirection' });
  // 声明与指令一类：树里各自有名字，认不出来就不猜。
  assert.deepEqual(await parseCommand('using module X', 'powershell'), { kind: 'unsupported', construct: 'using_directive_list' });
  assert.deepEqual(await parseCommand('class Foo { }', 'powershell'), { kind: 'unsupported', construct: 'class_statement' });
  assert.deepEqual(await parseCommand('function f { x }', 'powershell'), { kind: 'unsupported', construct: 'function_statement' });
  assert.deepEqual(await parseCommand('git status # drop', 'powershell'), { kind: 'unsupported', construct: 'comment' });
});

test('a PowerShell argument that is not a plain ASCII literal is reported instead of guessed', async () => {
  // 双引号在 PowerShell 里会展开：树把 `$(...)` 单列出来，但 `$x` 只是串里的文本，所以按内容而不是只按节点类型判。
  assert.deepEqual(await parseCommand('git commit -m "cost $(whoami)"', 'powershell'), {
    kind: 'unsupported',
    construct: 'an expandable string',
  });
  assert.deepEqual(await parseCommand('git commit -m $env:MSG', 'powershell'), { kind: 'unsupported', construct: 'variable' });
  // 这一批 Unicode 字符在 PowerShell 里是语法别名，落在字面量里也一样挡掉。
  assert.deepEqual(await parseCommand('Write-Host "a–b"', 'powershell'), { kind: 'unsupported', construct: 'a Unicode syntax alias' });
  // 解析报错与不认识的后缀运算都按无法完整处理对待，不降级成「按 bash 的直觉读一遍」。
  assert.deepEqual(await parseCommand('git log --author="Jane Doe"', 'powershell'), { kind: 'unsupported', construct: 'a syntax error' });
  assert.deepEqual(await parseCommand('git log -1', 'powershell'), { kind: 'unsupported', construct: 'expression_with_unary_operator' });
});
