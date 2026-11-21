import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/sync-community.mjs', import.meta.url));
const standards = resolve(fileURLToPath(new URL('..', import.meta.url)));

function run(args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args, cwd], { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'engineering-cmd-community-test-'));
  assert.equal(spawnSync('git', ['init', '--quiet', root], { cwd: root, encoding: 'utf8' }).status, 0);
  return root;
}

test('check is read-only and apply creates the two missing files', () => {
  const root = fixture();
  try {
    const absent = run(['--check'], root);
    assert.equal(absent.status, 1);
    assert.match(absent.stdout, /Missing: SECURITY\.md/);
    assert.match(absent.stdout, /Missing: CONTRIBUTING\.md/);
    assert.equal(existsSync(join(root, '.github/SECURITY.md')), false);
    assert.equal(existsSync(join(root, '.github/CONTRIBUTING.md')), false);

    const update = run(['--apply'], root);
    assert.equal(update.status, 0, update.stderr);
    assert.equal(run(['--check'], root).status, 0);
    assert.equal(readFileSync(join(root, '.github/SECURITY.md'), 'utf8'),
      readFileSync(join(standards, 'templates/SECURITY.md'), 'utf8'));
    assert.equal(readFileSync(join(root, '.github/CONTRIBUTING.md'), 'utf8'),
      readFileSync(join(standards, 'templates/CONTRIBUTING.md'), 'utf8'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an existing adapted copy is never overwritten', () => {
  const root = fixture();
  try {
    assert.equal(run(['--apply'], root).status, 0);
    const path = join(root, '.github/CONTRIBUTING.md');
    const adapted = '# Contributing\n\n## Security reports\n\nSee [SECURITY.md](SECURITY.md).\n';
    writeFileSync(path, adapted);

    const check = run(['--check'], root);
    assert.equal(check.status, 1);
    assert.match(check.stdout, /Incomplete: CONTRIBUTING\.md/);

    const apply = run(['--apply'], root);
    assert.equal(apply.status, 2);
    assert.match(apply.stderr, /manual review/);
    assert.equal(readFileSync(path, 'utf8'), adapted);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a second copy in another location is reported as a duplicate', () => {
  const root = fixture();
  try {
    assert.equal(run(['--apply'], root).status, 0);
    writeFileSync(join(root, 'SECURITY.md'), '# Security policy\n\n## Supported versions\n\n## Reporting\n');
    const check = run(['--check'], root);
    assert.equal(check.status, 1);
    assert.match(check.stdout, /Duplicate: SECURITY\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
