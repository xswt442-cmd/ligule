import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { spawnWindowsCommand } from '../dist/capability/windows-command.js';

test('Guardian AppContainer launch requires LOCALAPPDATA in the supplied environment', { skip: process.platform !== 'win32' }, async (t) => {
  const moduleUrl = pathToFileURL(resolve('dist/capability/windows-appcontainer-process.js')).href;
  const { createAppContainerProfile } = await import(moduleUrl);
  const profile = await createAppContainerProfile();
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot);
  const cmd = join(systemRoot, 'System32', 'cmd.exe');
  const safeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => new Set([
    'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SYSTEMDRIVE',
    'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
  ]).has(name.toUpperCase())));
  const minimalEnvironment = {
    SystemRoot: process.env.SystemRoot,
    PATH: process.env.PATH,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
  const canonicalPathEnvironment = {
    SystemRoot: process.env.SystemRoot,
    Path: process.env.Path,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
  const cases = [
    { name: 'safe-system32', cwd: join(systemRoot, 'System32'), environment: safeEnvironment },
    { name: 'minimal-system32', cwd: join(systemRoot, 'System32'), environment: minimalEnvironment },
    { name: 'minimal-canonical-path', cwd: join(systemRoot, 'System32'), environment: canonicalPathEnvironment },
    { name: 'safe-repository', cwd: resolve('.'), environment: safeEnvironment },
    { name: 'minimal-repository', cwd: resolve('.'), environment: minimalEnvironment },
    ...Object.entries(safeEnvironment)
      .filter(([name]) => !Object.hasOwn(minimalEnvironment, name) && !Object.keys(minimalEnvironment).some((minimalName) => minimalName.toUpperCase() === name.toUpperCase()))
      .map(([name, value]) => ({
        name: `minimal-plus-${name}`,
        cwd: join(systemRoot, 'System32'),
        environment: { ...minimalEnvironment, [name]: value },
      })),
  ];
  const outcomes = [];
  try {
    for (const scenario of cases) {
      const commandText = `echo GUARDIAN_APPCONTAINER_${scenario.name} & exit /b 23`;
      const owned = spawnWindowsCommand(cmd, ['/d', '/q', '/c', commandText], scenario.cwd, scenario.environment, {
        kind: 'appcontainer', profileName: profile.name,
      });
      let stdout = '';
      let stderr = '';
      owned.child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      owned.child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      try {
        outcomes.push({ name: scenario.name, exitCode: await owned.completion, stdout: stdout.trim(), stderr: stderr.trim() });
      } catch (error) {
        outcomes.push({ name: scenario.name, errorCode: error.code, detail: error.detail, stdout: stdout.trim(), stderr: stderr.trim() });
      }
    }
    t.diagnostic(JSON.stringify({
      cwdSystem32: join(systemRoot, 'System32'),
      cwdRepository: resolve('.'),
      safeEnvironmentKeys: Object.keys(safeEnvironment).sort(),
      minimalEnvironmentKeys: Object.keys(minimalEnvironment).sort(),
      canonicalPathEnvironmentKeys: Object.keys(canonicalPathEnvironment).sort(),
      outcomes,
    }));
    const successful = outcomes.find(({ name }) => name === 'safe-system32');
    assert.equal(successful?.exitCode, 23, JSON.stringify(outcomes));
    assert.match(successful?.stdout ?? '', /GUARDIAN_APPCONTAINER_safe-system32/u);
    const minimal = outcomes.find(({ name }) => name === 'minimal-system32');
    assert.equal(minimal?.errorCode, 'exec_guardian_failed', JSON.stringify(outcomes));
    assert.match(minimal?.detail ?? '', /CreateProcessW failed with Win32 error 203/u);
    const withLocalAppData = outcomes.find(({ name }) => name === 'minimal-plus-LOCALAPPDATA');
    assert.equal(withLocalAppData?.exitCode, 23, JSON.stringify(outcomes));
    assert.match(withLocalAppData?.stdout ?? '', /GUARDIAN_APPCONTAINER_minimal-plus-LOCALAPPDATA/u);
  } finally {
    await profile.dispose();
  }
});
