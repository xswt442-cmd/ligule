import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DESKTOP_PREFS_LIMIT_BYTES, loadPrefs, parsePrefsJson, prefsPathOf, readPrefs, savePrefs } from '../dist/kernel/desktop-prefs.js';

const tempRoot = join(process.cwd(), 'testplace', 'tmp');

async function makeDirectory() {
  const path = join(tempRoot, `desktop-prefs-${randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

async function childWrite(path, version, value) {
  const fixture = join(process.cwd(), 'test', 'fixtures', 'prefs-writer.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, path, version, JSON.stringify(value)], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      try {
        resolve({ code, result: JSON.parse(stdout), stderr });
      } catch (error) {
        reject(new Error(`prefs writer returned invalid output: ${stdout}${stderr}`, { cause: error }));
      }
    });
  });
}

async function assertNoWriteArtifacts(directory) {
  const entries = await readdir(directory);
  assert.equal(entries.some((name) => name.endsWith('.tmp')), false, '保存结束后不留临时文件');
  assert.equal(entries.some((name) => name.endsWith('.lock')), false, '保存结束后不留锁目录');
}

test('desktop preferences: reads distinguish a missing file from a valid empty object', async () => {
  const root = await makeDirectory();
  const path = join(root, 'nested', 'desktop.json');
  try {
    assert.deepEqual(await readPrefs(path), { settings: {}, version: '' });
    const saved = await savePrefs(path, {});
    assert.deepEqual(saved.settings, {});
    assert.equal(saved.version, createHash('sha256').update(await readFile(path)).digest('hex'));
    assert.notEqual(saved.version, '');
    assert.deepEqual(await readPrefs(path), saved);
    assert.deepEqual(await loadPrefs(path), {});
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600, '新文件仅允许本人读写');
    assert.equal(prefsPathOf('/home/someone'), join('/home/someone', '.ligule', 'desktop.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop preferences: malformed and non-object files are refused without changing their bytes', async () => {
  const root = await makeDirectory();
  const path = join(root, 'desktop.json');
  try {
    for (const original of ['{ not json', '[1,2]', '"text"']) {
      await writeFile(path, original, 'utf8');
      await assert.rejects(loadPrefs(path), (error) => error.code === 'desktop_prefs_invalid');
      await assert.rejects(readPrefs(path), (error) => error.code === 'desktop_prefs_invalid');
      await assert.rejects(savePrefs(path, { replacement: true }), (error) => error.code === 'desktop_prefs_invalid');
      assert.equal(await readFile(path, 'utf8'), original, '拒绝坏文件时原字节不变');
      await assertNoWriteArtifacts(root);
    }
    assert.throws(() => parsePrefsJson('{ not json'), (error) => error.code === 'desktop_prefs_invalid');
    assert.throws(() => parsePrefsJson('[1]'), (error) => error.code === 'desktop_prefs_invalid');
    assert.throws(() => parsePrefsJson('x'.repeat(DESKTOP_PREFS_LIMIT_BYTES + 1)), (error) => error.code === 'desktop_prefs_too_large');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop preferences: stale versions refuse a whole-file replacement', async () => {
  const root = await makeDirectory();
  const path = join(root, 'desktop.json');
  try {
    const initial = await savePrefs(path, { palette: 'forest' });
    const first = await savePrefs(path, { palette: 'sky' }, { version: initial.version });
    const bytes = await readFile(path);
    await assert.rejects(savePrefs(path, { palette: 'dusk' }, { version: initial.version }), (error) => error.code === 'desktop_prefs_version_stale');
    assert.deepEqual(await readFile(path), bytes, '过期版本拒写且原文件字节不变');
    assert.deepEqual(await loadPrefs(path), first.settings);
    await assertNoWriteArtifacts(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop preferences: two processes using one base version produce one save and one stale result', async () => {
  const root = await makeDirectory();
  const path = join(root, 'desktop.json');
  try {
    const base = await savePrefs(path, { stable: 'keep' });
    const outcomes = await Promise.all([
      childWrite(path, base.version, { stable: 'keep', writer: 'one' }),
      childWrite(path, base.version, { stable: 'keep', writer: 'two' }),
    ]);
    assert.equal(outcomes.filter((item) => item.code === 0).length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes.filter((item) => item.result?.code === 'desktop_prefs_version_stale').length, 1, JSON.stringify(outcomes));
    const landed = await loadPrefs(path);
    assert.equal(landed.stable, 'keep');
    assert.ok(landed.writer === 'one' || landed.writer === 'two');
    await assertNoWriteArtifacts(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop preferences: byte limits and existing permissions are enforced', async () => {
  const root = await makeDirectory();
  const path = join(root, 'desktop.json');
  try {
    const overLimit = { text: 'x'.repeat(DESKTOP_PREFS_LIMIT_BYTES) };
    await assert.rejects(savePrefs(path, overLimit), (error) => error.code === 'desktop_prefs_too_large');
    assert.equal((await readdir(root)).includes('desktop.json'), false, '超限新值不创建目标文件');
    await assertNoWriteArtifacts(root);
    await writeFile(path, ' '.repeat(DESKTOP_PREFS_LIMIT_BYTES + 1), 'utf8');
    await assert.rejects(loadPrefs(path), (error) => error.code === 'desktop_prefs_too_large');
    await assert.rejects(savePrefs(path, { next: true }), (error) => error.code === 'desktop_prefs_too_large');
    assert.equal((await readFile(path, 'utf8')).length, DESKTOP_PREFS_LIMIT_BYTES + 1, '超限原件字节不变');
    await rm(path);

    await writeFile(path, '{"old":true}\n', 'utf8');
    if (process.platform !== 'win32') await chmod(path, 0o640);
    await savePrefs(path, { next: true });
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o640, '替换后保留原权限位');
    await assertNoWriteArtifacts(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
