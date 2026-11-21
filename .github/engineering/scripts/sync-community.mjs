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
    headings: ['## Supported versions', '## Reporting', '## Scope', '## Handling'],
  },
  {
    name: 'CONTRIBUTING.md',
    template: 'templates/CONTRIBUTING.md',
    headings: ['## Branches', '## Pull request descriptions', '## Commit messages', '## Documentation', '## Verification', '## Security reports'],
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
    // 与已有社区文件保持同一位置：仓库把 SECURITY.md 放在根目录时，缺失的 CONTRIBUTING.md 也放在根目录。
    const companion = files
      .filter((spec) => spec.name !== result.spec.name)
      .map((spec) => copies(repo, spec.name)[0])
      .find((entry) => entry !== undefined);
    const relative = companion === undefined ? '.github' : companion.dir === 'repository root' ? '' : companion.dir;
    const target = join(repo, relative, result.spec.name);
    mkdirSync(dirname(target), { recursive: true });
    let template = readFileSync(join(sourceRoot, result.spec.template), 'utf8');
    // 模板链接按 .github/ 编写；写到仓库根目录时要改写成根目录相对路径。
    if (relative === '') {
      template = template
        .replaceAll('](../', '](')
        .replaceAll('](PULL_REQUEST_TEMPLATE.md)', '](.github/PULL_REQUEST_TEMPLATE.md)');
    }
    writeFileSync(target, template);
    console.log(`Created: ${target.slice(repo.length + 1)}`);
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
