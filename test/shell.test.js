import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveShell } from '../dist/index.js';

// 探测这一步用一条注入的查找代替真文件系统：这一具 Host 该挑哪一份解释器是逻辑，机器上真有什么是环境。
const windowsEnvironment = { ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Windows\\System32' };

function locates(...names) {
  const found = new Set(names);
  return (name) => (found.has(name) ? name : undefined);
}

test('an unknown backend name is refused at once', () => {
  assert.throws(
    () => resolveShell({ exec: { shell: 'cmd' } }, { platform: 'win32', environment: windowsEnvironment, locateExecutable: locates() }),
    (error) => error.code === 'exec_shell_unknown' && /expected one of auto, bash, powershell/.test(error.detail),
  );
});

test('auto on Windows takes PowerShell first, and PowerShell 7 before the built-in one', () => {
  const both = resolveShell({}, {
    platform: 'win32',
    environment: windowsEnvironment,
    locateExecutable: locates('pwsh.exe', 'powershell.exe'),
  });
  assert.equal(both.kind, 'powershell');
  assert.equal(both.executable, 'pwsh.exe');
  assert.deepEqual(both.prefix, ['-NoProfile', '-NonInteractive', '-Command']);
  // 命令文本后面那一段固定尾巴把真正的退出码带回来：Windows PowerShell 5.1 自己只交回 1（同文件里的实测记录）。
  assert.equal(both.suffix, '; exit $LASTEXITCODE');
});

test('auto on Windows falls back to Git Bash when there is no PowerShell', () => {
  const shell = resolveShell({}, {
    platform: 'win32',
    environment: windowsEnvironment,
    locateExecutable: locates('C:\\Program Files\\Git\\bin\\bash.exe'),
  });
  assert.equal(shell.kind, 'bash');
  assert.equal(shell.executable, 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.deepEqual(shell.prefix, ['-c']);
  assert.equal(shell.suffix, '');
});

test('auto on a POSIX platform takes bash from the usual locations in order', () => {
  const withPath = resolveShell({}, { platform: 'linux', environment: { PATH: '/usr/bin' }, locateExecutable: locates('bash') });
  assert.equal(withPath.executable, 'bash');
  const onlySh = resolveShell({}, { platform: 'linux', environment: { PATH: '/usr/bin' }, locateExecutable: locates('sh') });
  assert.equal(onlySh.executable, 'sh');
});

// 显式写了哪一种就只要那一种：回落成另一份等于跑了一份没人判过的语法。
test('an explicitly chosen backend that is missing is reported, not swapped for another', () => {
  assert.throws(
    () => resolveShell({ exec: { shell: 'powershell' } }, {
      platform: 'win32',
      environment: windowsEnvironment,
      locateExecutable: locates('bash.exe'),
    }),
    (error) => error.code === 'exec_shell_unavailable'
      && /exec\.shell="powershell"/.test(error.detail)
      && /pwsh\.exe, powershell\.exe/.test(error.detail)
      && !error.detail.includes('bash'),
  );
});

test('nothing at all on the machine is a stable code naming what was searched', () => {
  assert.throws(
    () => resolveShell({}, { platform: 'win32', environment: { PATH: '' }, locateExecutable: locates() }),
    (error) => error.code === 'exec_shell_unavailable' && /powershell:.*bash:/s.test(error.detail),
  );
});
