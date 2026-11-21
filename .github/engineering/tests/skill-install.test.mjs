import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../skills/mypr/scripts/install.mjs', import.meta.url));
const docsInstaller = fileURLToPath(new URL('../skills/mydocs/scripts/install.mjs', import.meta.url));
const skills = resolve(fileURLToPath(new URL('..', import.meta.url)), 'skills');

function run(args, cwd, script = installer) {
  const result = spawnSync(process.execPath, [script, ...args, cwd], { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function git(args, cwd) {
  return spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'engineering-cmd-skill-test-'));
  assert.equal(spawnSync('git', ['init', '--quiet', root], { cwd: root, encoding: 'utf8' }).status, 0);
  return root;
}

test('check is read-only, apply installs the skill and the files it mirrors', () => {
  const root = fixture();
  try {
    const absent = run(['--check'], root);
    assert.equal(absent.status, 1);
    assert.match(absent.stdout, /Out of sync: \.agents\/skills\/mypr\/SKILL\.md/);
    assert.match(absent.stdout, /Out of sync: \.github\/PULL_REQUEST_TEMPLATE\.md/);
    assert.equal(existsSync(join(root, '.agents')), false);
    assert.equal(existsSync(join(root, '.github/PULL_REQUEST_TEMPLATE.md')), false);

    const update = run(['--apply'], root);
    assert.equal(update.status, 0, update.stderr);
    assert.equal(run(['--check'], root).status, 0);
    assert.equal(readFileSync(join(root, '.agents/skills/mypr/SKILL.md'), 'utf8'),
      readFileSync(join(skills, 'mypr/SKILL.md'), 'utf8'));
    assert.equal(readFileSync(join(root, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8'),
      readFileSync(join(skills, 'mypr/repo/.github/PULL_REQUEST_TEMPLATE.md'), 'utf8'));

    // The installer itself is tooling, not part of the installed skill.
    assert.equal(existsSync(join(root, '.agents/skills/mypr/scripts')), false);
    assert.equal(existsSync(join(root, '.agents/skills/mypr/repo')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a skill without a repo mirror leaves the repository root alone', () => {
  const root = fixture();
  try {
    const update = run(['--apply'], root, docsInstaller);
    assert.equal(update.status, 0, update.stderr);
    assert.equal(run(['--check'], root, docsInstaller).status, 0);
    assert.equal(existsSync(join(root, '.agents/skills/mydocs/references/file-types.md')), true);
    assert.equal(existsSync(join(root, '.github')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('locally modified files and symlink targets are refused', () => {
  const root = fixture();
  try {
    assert.equal(run(['--apply'], root).status, 0);
    assert.equal(git(['add', '.github', '.agents'], root).status, 0);
    assert.equal(git(['commit', '--quiet', '-m', 'install'], root).status, 0);

    writeFileSync(join(root, '.agents/skills/mypr/SKILL.md'), 'User change\n');
    const refused = run(['--apply'], root);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /Refusing to overwrite locally modified/);
    assert.equal(readFileSync(join(root, '.agents/skills/mypr/SKILL.md'), 'utf8'), 'User change\n');

    const linked = fixture();
    try {
      mkdirSync(join(linked, '.agents/skills'), { recursive: true });
      symlinkSync(join(skills, 'mypr'), join(linked, '.agents/skills/mypr'), 'junction');
      const denied = run(['--apply'], linked);
      assert.equal(denied.status, 2);
      assert.match(denied.stderr, /Refusing symlink target/);
    } finally {
      rmSync(linked, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source reports the commit the copy came from', () => {
  const source = spawnSync(process.execPath, [installer, '--source'], { encoding: 'utf8' });
  assert.equal(source.status, 0);
  // 刚同步进来、还没提交的副本没有历史，--source 只能报 unknown。
  assert.match(source.stdout, /^mypr: ([0-9a-f]{7,} \d{4}-\d{2}-\d{2}|unknown)$/m);
});
