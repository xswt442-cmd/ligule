// 桌面偏好那一份文档（方案 5.5.2）：整份替换、先写临时文件再改名、坏东西不进文件，读坏了就用默认。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DESKTOP_PREFS_LIMIT_BYTES, loadPrefs, parsePrefsJson, prefsPathOf, savePrefs } from '../dist/kernel/desktop-prefs.js';

test('desktop preferences: one document replaced whole, atomically, with no temporary left behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-prefs-'));
  const path = join(root, 'nested', 'desktop.json');
  try {
    assert.deepEqual(await loadPrefs(path), {}, '还没有过任何一次保存不是错误');
    await savePrefs(path, { palette: 'forest', drafts: { '/p': { s1: '没发出去的一句' } } });
    assert.deepEqual(await loadPrefs(path), { palette: 'forest', drafts: { '/p': { s1: '没发出去的一句' } } });
    await savePrefs(path, { palette: 'dusk' });
    assert.deepEqual(await loadPrefs(path), { palette: 'dusk' }, '整份替换：上一次写下的那些键不残留');
    // 差不多同时到的两次保存：排一条队按先后落盘，文件里留下后发起的那一份，不是先落笔的那一份。
    await Promise.all([savePrefs(path, { a: 1 }), savePrefs(path, { b: 2 })]);
    assert.deepEqual(await loadPrefs(path), { b: 2 });
    assert.deepEqual((await readdir(join(root, 'nested'))).filter((name) => name.endsWith('.tmp')), [], '收尾不留临时文件');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop preferences: a broken or non-object document reads as defaults, and the write boundary refuses it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-prefs-'));
  const path = join(root, 'desktop.json');
  try {
    assert.equal(prefsPathOf('/home/someone'), join('/home/someone', '.ligule', 'desktop.json'), '缺省位置在应用数据根的 desktop.json');
    await writeFile(path, '{ not json', 'utf8');
    assert.deepEqual(await loadPrefs(path), {}, '读坏了就用默认，不猜它想表达什么');
    await writeFile(path, '[1,2]', 'utf8');
    assert.deepEqual(await loadPrefs(path), {}, '不是对象的那一份也按默认走');
    assert.throws(() => parsePrefsJson('{ not json'), (error) => error.code === 'desktop_prefs_invalid', '读不出来的那一份不上桥');
    assert.throws(() => parsePrefsJson('[1]'), (error) => error.code === 'desktop_prefs_invalid');
    assert.throws(() => parsePrefsJson('"text"'), (error) => error.code === 'desktop_prefs_invalid');
    assert.throws(() => parsePrefsJson('x'.repeat(DESKTOP_PREFS_LIMIT_BYTES + 1)), (error) => error.code === 'desktop_prefs_too_large', '超过字节上限的那一份也拒');
    assert.deepEqual(parsePrefsJson('{"palette":"sky"}'), { palette: 'sky' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
