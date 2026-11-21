// Checks the two community health files a public repository is expected to keep.
// GitHub resolves these fixed names from .github/, the repository root, or docs/,
// in that order. Downstream repositories adapt the content to their own facts, so
// the check covers placement and required sections rather than byte equality with
// the canonical templates. Existing copies are never overwritten.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const locations = ['.github', '', 'docs'];
const files = [
  {
    name: 'SECURITY.md',
    template: 'templates/SECURITY.md',
    headings: ['## Supported versions', '## Reporting'],
  },
  {
    name: 'CONTRIBUTING.md',
    template: 'templates/CONTRIBUTING.md',
    headings: ['## Verification'],
    reference: 'SECURITY.md',
  },
];

function copies(repo, name) {
  return locations
    .map((dir) => ({ dir: dir || 'repository root', path: dir ? join(repo, dir, name) : join(repo, name) }))
    .filter((entry) => existsSync(entry.path));
}

function inspect(repo, spec) {
  const present = copies(repo, spec.name);
  if (present.length === 0) return { spec, state: 'missing' };
  if (present.length > 1) {
    return { spec, state: 'duplicate', places: present.map((entry) => entry.dir) };
  }
  const text = readFileSync(present[0].path, 'utf8');
  const absent = spec.headings.filter((heading) => !text.includes(heading));
  if (spec.reference && !text.includes(spec.reference)) absent.push(spec.reference);
  if (absent.length) return { spec, state: 'incomplete', place: present[0].dir, absent };
  return { spec, state: 'ok', place: present[0].dir };
}

function sync(repo, apply) {
  if (!existsSync(join(repo, '.git'))) throw new Error('Target is not a Git working tree');
  const results = files.map((spec) => inspect(repo, spec));
  for (const result of results) {
    if (result.state === 'ok') console.log(`OK: ${result.spec.name} (${result.place})`);
    else if (result.state === 'missing') console.log(`Missing: ${result.spec.name}`);
    else if (result.state === 'duplicate') console.log(`Duplicate: ${result.spec.name} in ${result.places.join(', ')}`);
    else console.log(`Incomplete: ${result.spec.name} (${result.place}) lacks ${result.absent.join(', ')}`);
  }
  const problems = results.filter((result) => result.state !== 'ok');
  if (!problems.length) {
    console.log('Community health files are present and complete.');
    return;
  }
  if (!apply) {
    console.error('Run with --apply to create missing files from the canonical templates. Existing files are never overwritten.');
    process.exitCode = 1;
    return;
  }
  let unresolved = 0;
  for (const result of problems) {
    if (result.state !== 'missing') {
      unresolved += 1;
      continue;
    }
    const target = join(repo, '.github', result.spec.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(sourceRoot, result.spec.template)));
    console.log(`Created: .github/${result.spec.name}`);
  }
  if (unresolved) {
    console.error(`${unresolved} file(s) need a manual review; this tool never overwrites an existing copy.`);
    process.exitCode = 2;
  }
}

if (process.argv.length !== 4 || !['--check', '--apply'].includes(process.argv[2])) {
  console.error('Usage: node .github/engineering/scripts/sync-community.mjs --check|--apply /path/to/repository');
  process.exitCode = 2;
} else {
  try {
    sync(resolve(process.argv[3]), process.argv[2] === '--apply');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
