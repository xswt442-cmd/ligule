#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This script ships inside the skill it installs. Everything it needs comes from its own directory:
//   <file>                   -> <repo>/.agents/skills/<skill>/
//   repo/<path>              -> <repo>/<path>
//   scripts/install.mjs      -> the installer itself, never installed
//   scripts/<other file>     -> <repo>/.agents/skills/<skill>/scripts/<other file>
// A directory rename or a new reference file therefore needs no change here.

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillName = skillRoot.split(/[\\/]/).pop();
// Only the installer stays behind. The checkers live in scripts/ too, and the
// installed copy must keep them so `node .agents/skills/<skill>/scripts/...` works.
const skip = new Set(['repo']);
const isInstaller = (file) => file === 'scripts/install.mjs';

function walk(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full, base));
    else files.push(relative(base, full).split('\\').join('/'));
  }
  return files;
}

function plan(repo) {
  const items = [];
  for (const file of walk(skillRoot)) {
    if (skip.has(file.split('/')[0]) || isInstaller(file)) continue;
    items.push({ path: `.agents/skills/${skillName}/${file}`, from: join(skillRoot, file) });
  }
  const mirror = join(skillRoot, 'repo');
  if (existsSync(mirror)) {
    for (const file of walk(mirror)) items.push({ path: file, from: join(mirror, file) });
  }
  return items;
}

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.trim() || result.error?.message || 'unknown error'}`);
  }
  return result.stdout.trim();
}

function assertNotSymlink(repo, path) {
  let current = repo;
  for (const part of path.split('/')) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlink target: ${path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function sourceRef() {
  const result = spawnSync('git', ['-C', skillRoot, 'log', '-1', '--format=%h %cs', '--', '.'], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : 'unknown';
}

function sync(repo, apply) {
  if (!existsSync(join(repo, '.git'))) throw new Error('Target is not a Git working tree');
  // On Windows the caller's path can carry an 8.3 short name (RUNNER~1) while git always
  // reports the long one, so a string comparison rejects the correct repository. Resolve
  // both sides to their real path first. realpathSync.native expands short names; the plain
  // version does not.
  const real = (path) => realpathSync.native(path);
  const top = real(git(repo, ['rev-parse', '--show-toplevel']));
  if (top.toLowerCase() !== real(repo).toLowerCase()) throw new Error('Target must be the repository root');

  const changed = [];
  for (const item of plan(repo)) {
    const target = join(repo, item.path);
    assertNotSymlink(repo, item.path);
    const source = readFileSync(item.from);
    if (existsSync(target) && readFileSync(target).equals(source)) continue;
    changed.push({ ...item, target, source });
  }

  // Validate every affected path before writing anything, so a refusal cannot leave a half-written install.
  if (apply) {
    for (const item of changed) {
      const status = git(repo, ['status', '--porcelain', '--', item.path]);
      if (status) throw new Error(`Refusing to overwrite locally modified or untracked file: ${item.path} (${status})`);
    }
    for (const item of changed) {
      mkdirSync(dirname(item.target), { recursive: true });
      writeFileSync(item.target, item.source);
    }
  }

  for (const item of changed) console.log(`${apply ? 'Updated' : 'Out of sync'}: ${item.path}`);
  const ref = sourceRef();
  if (!changed.length) console.log(`${skillName} matches its source (${ref}).`);
  else if (!apply) {
    console.error(`Run with --apply to install ${skillName} after reviewing the target repository.`);
    process.exitCode = 1;
  } else console.log(`${skillName} installed from ${ref}.`);
}

const [mode, target] = process.argv.slice(2);
if (mode === '--source') {
  console.log(`${skillName}: ${sourceRef()}`);
} else if (mode === '--check' || mode === '--apply') {
  try {
    sync(resolve(target ?? '.'), mode === '--apply');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
} else {
  console.error(`Usage: node skills/${skillName}/scripts/install.mjs --check|--apply [repository] | --source`);
  process.exitCode = 2;
}
