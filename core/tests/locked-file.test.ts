import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { withLockedAtomicFile } from '../dist/storage/locked-file.js';

test('withLockedAtomicFile serializes concurrent in-process writes per normalized path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ligule-locked-file-'));
  const target = join(dir, 'state.json');
  try {
    await writeFile(target, '0', 'utf8');
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((step) => withLockedAtomicFile(target, {
      run: async () => {
        const current = Number(await readFile(target, 'utf8'));
        await new Promise((resolve) => setTimeout(resolve, 15));
        const next = current + 1;
        order.push(step);
        return { content: String(next), result: next };
      },
    })));
    assert.equal(await readFile(target, 'utf8'), '3');
    assert.equal(order.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('withLockedAtomicFile retries Windows rename errors and cleans temp files on permanent failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ligule-locked-rename-'));
  const target = join(dir, 'prefs.json');
  try {
    let attempts = 0;
    const saved = await withLockedAtomicFile(target, {
      renameMaxAttempts: 3,
      renameMaxBackoffMs: 10,
      run: async () => ({ content: 'ok', result: 'done' }),
    }, async (src, dst) => {
      attempts += 1;
      if (process.platform === 'win32' && attempts < 3) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      const { rename } = await import('node:fs/promises');
      await rename(src, dst);
    });
    assert.equal(saved, 'done');
    assert.equal(await readFile(target, 'utf8'), 'ok');
    if (process.platform === 'win32') assert.equal(attempts, 3);

    await assert.rejects(
      () => withLockedAtomicFile(target, {
        renameMaxAttempts: 1,
        renameMaxBackoffMs: 5,
        errors: { onReplaceFailed: (cause) => Object.assign(new Error('replace_failed'), { code: 'replace_failed', cause }) },
        run: async () => ({ content: 'fail', result: 'never' }),
      }, async () => {
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      }),
      (error: Error & { code?: string }) => error.code === 'replace_failed',
    );
    const entries = await readdir(dir);
    assert.deepEqual(entries, ['prefs.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
