import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/sync-pr.mjs', import.meta.url));
const standards = resolve(fileURLToPath(new URL('..', import.meta.url)));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

test('a repository root reached through a directory link is accepted while a nested directory is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'engineering-root-link-test-'));
  try {
    const repository = join(root, 'repository');
    const alias = join(root, 'alias');
    const nested = join(repository, 'nested');
    mkdirSync(repository);
    mkdirSync(nested);
    assert.equal(run('git', ['init', '--quiet', repository], root).status, 0);
    symlinkSync(repository, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const check = run(process.execPath, [script, '--check', alias], root);
    assert.equal(check.status, 1, check.stderr);
    assert.match(check.stdout, /Out of sync: \.github\/PULL_REQUEST_TEMPLATE\.md/);
    const refused = run(process.execPath, [script, '--check', nested], root);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /Target is not a Git working tree|Target must be the repository root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check is read-only, apply updates four files, and dirty edits block overwrites', () => {
  const root = mkdtempSync(join(tmpdir(), 'engineering-cmd-pr-test-'));
  try {
    assert.equal(run('git', ['init', '--quiet', root], root).status, 0);
    writeFileSync(join(root, 'README.md'), 'Fixture\n');
    assert.equal(run('git', ['add', 'README.md'], root).status, 0);
    assert.equal(run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
      'commit', '--quiet', '-m', 'init'], root).status, 0);

    const absent = run(process.execPath, [script, '--check', root], root);
    assert.equal(absent.status, 1);
    assert.match(absent.stdout, /Out of sync: \.github\/PULL_REQUEST_TEMPLATE\.md/);
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'Fixture\n');

    const update = run(process.execPath, [script, '--apply', root], root);
    assert.equal(update.status, 0, update.stderr);
    assert.equal(run(process.execPath, [script, '--check', root], root).status, 0);
    assert.equal(readFileSync(join(root, '.agents/skills/pr/SKILL.md'), 'utf8'),
      readFileSync(join(standards, 'skills/pr/SKILL.md'), 'utf8'));
    assert.equal(readFileSync(join(root, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8'),
      readFileSync(join(standards, 'templates/PULL_REQUEST_TEMPLATE.md'), 'utf8'));

    assert.equal(run('git', ['add', '.github', '.agents'], root).status, 0);
    assert.equal(run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
      'commit', '--quiet', '-m', 'install'], root).status, 0);
    writeFileSync(join(root, '.agents/skills/pr/SKILL.md'), 'User change\n');
    const refused = run(process.execPath, [script, '--apply', root], root);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /Refusing to overwrite locally modified/);
    assert.equal(readFileSync(join(root, '.agents/skills/pr/SKILL.md'), 'utf8'), 'User change\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ignored untracked destination blocks apply before any destination is written', () => {
  const root = mkdtempSync(join(tmpdir(), 'engineering-cmd-pr-ignored-test-'));
  try {
    assert.equal(run('git', ['init', '--quiet', root], root).status, 0);
    writeFileSync(join(root, '.gitignore'), '.agents/\n');
    writeFileSync(join(root, 'README.md'), 'Fixture\n');
    assert.equal(run('git', ['add', '.gitignore', 'README.md'], root).status, 0);
    assert.equal(run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
      'commit', '--quiet', '-m', 'init'], root).status, 0);

    const ignoredTarget = join(root, '.agents/skills/pr/SKILL.md');
    mkdirSync(join(root, '.agents/skills/pr'), { recursive: true });
    writeFileSync(ignoredTarget, 'User data\n');

    const refused = run(process.execPath, [script, '--apply', root], root);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /Refusing to overwrite locally modified or untracked file: \.agents\/skills\/pr\/SKILL\.md/);
    assert.equal(readFileSync(ignoredTarget, 'utf8'), 'User data\n');
    assert.equal(existsSync(join(root, '.github/PULL_REQUEST_TEMPLATE.md')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
