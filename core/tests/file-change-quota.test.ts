import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createFileChangeStore, FILE_CHANGE_MAX_FILE_BYTES, FILE_CHANGE_MAX_SESSION_BYTES } from '../dist/session/file-changes.js';
import type { FileChangeFact } from '../dist/session/file-changes.js';

async function inSessionDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const root = join(process.cwd(), 'testplace', 'tmp');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'file-change-quota-'));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}

test('file change baselines accept exactly 256 KiB and keep the original bytes', async () => {
  await inSessionDirectory(async (directory) => {
    const records: FileChangeFact[] = [];
    const store = createFileChangeStore({ directory, read: async () => [] }).forCall(records);
    const target = join(directory, 'after.txt');
    const before = Buffer.alloc(FILE_CHANGE_MAX_FILE_BYTES, 0x61);
    const after = Buffer.from('after');
    await writeFile(target, after);
    await store.record({ path: 'after.txt', target, operation: 'edit', outcome: 'written', beforeExists: true,
      beforeBytes: before, expectedAfterExists: true, expectedAfterBytes: after });
    const baseline = records[0]?.baselineRef;
    assert.ok(baseline);
    assert.equal(baseline.bytes, FILE_CHANGE_MAX_FILE_BYTES);
    assert.deepEqual(await readFile(join(directory, baseline.name)), before);

    const tooLarge = Buffer.alloc(FILE_CHANGE_MAX_FILE_BYTES + 1, 0x62);
    const otherTarget = join(directory, 'large-after.txt');
    await writeFile(otherTarget, after);
    await store.record({ path: 'large-after.txt', target: otherTarget, operation: 'edit', outcome: 'written', beforeExists: true,
      beforeBytes: tooLarge, expectedAfterExists: true, expectedAfterBytes: after });
    assert.equal(records[1]?.baselineStatus, 'unavailable');
    assert.equal(records[1]?.baselineReason, 'file_too_large');
    assert.equal(records[1]?.baselineRef, undefined);
  });
});

test('file change baselines enforce the 16 MiB Session budget without rejecting writes', async () => {
  await inSessionDirectory(async (directory) => {
    assert.equal(FILE_CHANGE_MAX_SESSION_BYTES, 16 * 1024 * 1024);
    const records: FileChangeFact[] = [];
    const store = createFileChangeStore({ directory, read: async () => [] }).forCall(records);
    const before = Buffer.alloc(FILE_CHANGE_MAX_FILE_BYTES, 0x61);
    const after = Buffer.from('after');
    for (let index = 0; index < FILE_CHANGE_MAX_SESSION_BYTES / FILE_CHANGE_MAX_FILE_BYTES; index += 1) {
      const relativePath = `file-${index}.txt`;
      const target = join(directory, relativePath);
      await writeFile(target, after);
      await store.record({ path: relativePath, target, operation: 'edit', outcome: 'written', beforeExists: true,
        beforeBytes: before, expectedAfterExists: true, expectedAfterBytes: after });
    }
    assert.equal(records.length, 64);
    assert.equal(records.reduce((sum, item) => sum + (item.baselineRef?.bytes ?? 0), 0), FILE_CHANGE_MAX_SESSION_BYTES);
    const target = join(directory, 'beyond-quota.txt');
    await writeFile(target, after);
    await store.record({ path: 'beyond-quota.txt', target, operation: 'edit', outcome: 'written', beforeExists: true,
      beforeBytes: Buffer.from('x'), expectedAfterExists: true, expectedAfterBytes: after });
    assert.equal(records[64]?.outcome, 'written', 'baseline quota does not change the authorized mutation outcome');
    assert.equal(records[64]?.baselineStatus, 'unavailable');
    assert.equal(records[64]?.baselineReason, 'session_quota_exceeded');
    assert.equal(records[64]?.baselineRef, undefined);
  });
});

test('reopened Sessions reuse the original baseline and report a damaged snapshot as unknown', async () => {
  await inSessionDirectory(async (directory) => {
    const initial: FileChangeFact[] = [];
    const firstTarget = join(directory, 'reopen.txt');
    const original = Buffer.from('original\r\n', 'utf8');
    const first = Buffer.from('first edit\n', 'utf8');
    await writeFile(firstTarget, first);
    const firstStore = createFileChangeStore({ directory, read: async () => [] }).forCall(initial);
    await firstStore.record({ path: 'reopen.txt', target: firstTarget, operation: 'edit', outcome: 'written',
      beforeExists: true, beforeBytes: original, expectedAfterExists: true, expectedAfterBytes: first });
    const firstRef = initial[0]?.baselineRef;
    assert.ok(firstRef);

    const reopenedFacts: FileChangeFact[] = [];
    const reopened = createFileChangeStore({ directory, read: async () => [{ kind: 'tool', fileChanges: initial }] })
      .forCall(reopenedFacts);
    const second = Buffer.from('second edit\n', 'utf8');
    await writeFile(firstTarget, second);
    await reopened.record({ path: 'reopen.txt', target: firstTarget, operation: 'edit', outcome: 'written',
      beforeExists: true, beforeBytes: first, expectedAfterExists: true, expectedAfterBytes: second });
    assert.equal(reopenedFacts[0]?.baselineRef?.name, firstRef.name);
    assert.equal(reopenedFacts[0]?.baselineVersion, initial[0]?.baselineVersion);
    assert.equal(reopenedFacts[0]?.changedFromBaseline, true,
      'the later mutation is compared with the first saved baseline, not its immediate before image');
    assert.equal((await readdir(directory)).filter((name) => name.endsWith('.snapshot')).length, 1,
      'reopening does not make a second baseline copy for the same path');

    await writeFile(join(directory, firstRef.name), 'damaged baseline');
    const damagedFacts: FileChangeFact[] = [];
    const damaged = createFileChangeStore({ directory, read: async () => [{ kind: 'tool', fileChanges: initial }] })
      .forCall(damagedFacts);
    await writeFile(firstTarget, Buffer.from('third edit\n'));
    await damaged.record({ path: 'reopen.txt', target: firstTarget, operation: 'edit', outcome: 'written',
      beforeExists: true, beforeBytes: second, expectedAfterExists: true, expectedAfterBytes: Buffer.from('third edit\n') });
    assert.equal(damagedFacts[0]?.baselineStatus, 'unknown');
    assert.equal(damagedFacts[0]?.baselineReason, 'baseline_snapshot_unavailable');
    assert.equal(damagedFacts[0]?.changedFromBaseline, null);
  });
});

test('two Sessions sharing one storage directory keep separate baselines and quotas', async () => {
  await inSessionDirectory(async (directory) => {
    const firstFacts: FileChangeFact[] = [];
    const firstStore = createFileChangeStore({ id: 'session-a', directory, read: async () => [] }).forCall(firstFacts);
    const before = Buffer.alloc(FILE_CHANGE_MAX_FILE_BYTES, 0x61);
    const after = Buffer.from('after');
    for (let index = 0; index < FILE_CHANGE_MAX_SESSION_BYTES / FILE_CHANGE_MAX_FILE_BYTES; index += 1) {
      const path = `a-${index}.txt`;
      const target = join(directory, path);
      await writeFile(target, after);
      await firstStore.record({ path, target, operation: 'edit', outcome: 'written', beforeExists: true,
        beforeBytes: before, expectedAfterExists: true, expectedAfterBytes: after });
    }
    assert.equal(firstFacts[0]?.baselineStatus, 'available');
    assert.equal(firstFacts.at(-1)?.baselineStatus, 'available');

    const secondFacts: FileChangeFact[] = [];
    const secondStore = createFileChangeStore({ id: 'session-b', directory, read: async () => [] }).forCall(secondFacts);
    const secondTarget = join(directory, 'a-0.txt');
    await secondStore.record({ path: 'a-0.txt', target: secondTarget, operation: 'edit', outcome: 'written',
      beforeExists: true, beforeBytes: after, expectedAfterExists: true, expectedAfterBytes: after });
    assert.equal(secondFacts[0]?.baselineStatus, 'available', 'another Session’s 16 MiB does not consume this Session’s quota');
    const firstRef = firstFacts[0]?.baselineRef;
    const secondRef = secondFacts[0]?.baselineRef;
    assert.ok(firstRef && secondRef);
    assert.notEqual(firstRef.name, secondRef.name, 'snapshot names are Session-scoped inside the shared directory');
    assert.deepEqual(await readFile(join(directory, secondRef.name)), after);
  });
});
