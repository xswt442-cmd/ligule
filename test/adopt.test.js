// 数据根会话区：缺省解析落在数据根，旧位置的一次性复制校验可重跑、原件保留（D110、方案 5.5.2；
// 合同 `ligule-set/phase3/r55-data-root-contract.md`）。这些是与临时目录打交道的纯函数级检查，不起进程。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { adoptForSessionDirectory, adoptLegacySessions, sessionDirectory } from '../dist/index.js';

test('the default session directory is the data root one, and host.sessionDirectory stays on top', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ligule-session-dir-'));
  const previous = process.env.LIGULE_HOME;
  delete process.env.LIGULE_HOME;
  try {
    assert.equal(sessionDirectory({ boundary: join(home, 'project'), userHome: home }), join(home, '.ligule', 'sessions'));
    assert.equal(sessionDirectory({ boundary: join(home, 'project'), userHome: home, host: { sessionDirectory: join(home, 'given') } }), join(home, 'given'));
  } finally {
    if (previous !== undefined) process.env.LIGULE_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('legacy session files are copied once into the data root and the originals stay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-'));
  try {
    const legacy = join(root, 'project', '.ligule', 'sessions');
    const target = join(root, 'home', '.ligule', 'sessions');
    await mkdir(join(legacy, 'aaa.lock'), { recursive: true });
    await writeFile(join(legacy, 'aaa.jsonl'), '{"kind":"user"}\n', 'utf8');
    await writeFile(join(legacy, 'aaa.checkpoint.json'), '{}\n', 'utf8');
    await writeFile(join(legacy, 'result-3-abcdef01.json'), 'x'.repeat(10), 'utf8');
    await writeFile(join(legacy, 'notes.txt'), 'x', 'utf8');

    const first = await adoptLegacySessions(legacy, target);
    assert.deepEqual(first.copied.sort(), ['aaa.checkpoint.json', 'aaa.jsonl', 'result-3-abcdef01.json']);
    assert.deepEqual(first.unknown, ['notes.txt'], '不认识的条目列出来、不复制');
    assert.equal(await readFile(join(legacy, 'aaa.jsonl'), 'utf8'), '{"kind":"user"}\n', '原件保留');
    // 补齐的那一份保住记录自己的时间：`updatedAt` 读的是文件时间，列表按它排序（POSIX 的 copyFile 会改成此刻）。
    // `utimes` 走 Date（只到整毫秒），源时间带毫秒以下的小数位时两边差在这一格以内；列表显示到毫秒，已经一致。
    const [source, copied] = await Promise.all([stat(join(legacy, 'aaa.jsonl')), stat(join(target, 'aaa.jsonl'))]);
    assert.ok(Math.abs(copied.mtimeMs - source.mtimeMs) <= 1, `补齐不改那一份自己的时间：${copied.mtimeMs} 对 ${source.mtimeMs}`);

    const second = await adoptLegacySessions(legacy, target);
    assert.deepEqual(second.copied, [], '再跑只做比对');
    assert.deepEqual(second.already.sort(), ['aaa.checkpoint.json', 'aaa.jsonl', 'result-3-abcdef01.json']);

    // 目标已有同编号而字节不同：停下交回，不覆盖目标那一份。
    await writeFile(join(target, 'aaa.jsonl'), 'changed\n', 'utf8');
    const third = await adoptLegacySessions(legacy, target);
    assert.deepEqual(third.conflicts, ['aaa.jsonl']);
    assert.equal(await readFile(join(target, 'aaa.jsonl'), 'utf8'), 'changed\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adoption stays off when host.sessionDirectory points somewhere on purpose', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-adopt-off-'));
  try {
    const legacy = join(root, 'project', '.ligule', 'sessions');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'aaa.jsonl'), '{}\n', 'utf8');
    const off = await adoptForSessionDirectory({ boundary: join(root, 'project'), host: { sessionDirectory: join(root, 'given') } }, join(root, 'given'));
    assert.equal(off, null, '覆盖指了位置的机器不碰旧位置');
    const on = await adoptForSessionDirectory({ boundary: join(root, 'project') }, join(root, 'elsewhere'));
    assert.deepEqual(on.copied, ['aaa.jsonl']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
