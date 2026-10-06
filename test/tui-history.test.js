import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadHistory, rememberHistory } from '../dist/tui/history.js';

const testplace = resolve('testplace');

async function withHistoryDirectory(run) {
  const directory = await mkdtemp(join(testplace, 'tui-history-'));
  const absoluteDirectory = resolve(directory);
  assert.equal(absoluteDirectory.startsWith(`${testplace}${process.platform === 'win32' ? '\\' : '/'}`), true);
  try {
    await run(directory);
  } finally {
    await rm(absoluteDirectory, { recursive: true, force: true });
  }
}

test('history saves serialize, merge concurrent snapshots, and use distinct temporary files', async () => {
  await mkdir(testplace, { recursive: true });
  await withHistoryDirectory(async (directory) => {
    const path = join(directory, 'history.jsonl');
    await Promise.all([
      rememberHistory(path, ['first']),
      rememberHistory(path, ['second']),
      rememberHistory(path, ['third']),
    ]);
    const entries = await loadHistory(path);
    assert.deepEqual(entries, ['third', 'second', 'first']);
    assert.deepEqual((await readdir(directory)).sort(), ['history.jsonl']);
  });
});

test('history reads reject malformed and non-string lines with a stable code', async () => {
  await mkdir(testplace, { recursive: true });
  await withHistoryDirectory(async (directory) => {
    const path = join(directory, 'history.jsonl');
    await writeFile(path, '"valid"\nnot-json\n');
    await assert.rejects(loadHistory(path), (error) => error.code === 'tui_history_invalid' && error.line === 2);
    await writeFile(path, '42\n');
    await assert.rejects(loadHistory(path), (error) => error.code === 'tui_history_invalid' && error.line === 1);
  });
});

test('failed history replacement removes its temporary file', async () => {
  await mkdir(testplace, { recursive: true });
  await withHistoryDirectory(async (directory) => {
    const path = join(directory, 'occupied');
    await mkdir(path);
    await writeFile(join(path, 'keep'), 'content');
    await assert.rejects(rememberHistory(path, ['sentence']));
    assert.deepEqual((await readdir(directory)).sort(), ['occupied']);
    assert.equal(await readFile(join(path, 'keep'), 'utf8'), 'content');
  });
});
