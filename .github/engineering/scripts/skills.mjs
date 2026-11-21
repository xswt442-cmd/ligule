#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Each skill ships its own installer, so this file only fans out and aggregates exit codes.
// A new skill directory under skills/ is picked up without editing this script.

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const args = process.argv.slice(2);
const mode = args[0];

if (!['--check', '--apply', '--source'].includes(mode)) {
  console.error('Usage: node .github/engineering/scripts/skills.mjs --check|--apply [repository] | --source');
  process.exit(2);
}

let status = 0;
let found = 0;

for (const name of readdirSync(skillsDir).sort()) {
  const installer = join(skillsDir, name, 'scripts', 'install.mjs');
  if (!existsSync(installer)) continue;
  found += 1;
  const result = spawnSync(process.execPath, [installer, ...args], { stdio: 'inherit' });
  if (result.status !== 0 && status === 0) status = result.status ?? 1;
}

if (!found) {
  console.error('No skill installer found under .github/engineering/skills/.');
  status = 2;
}
if (status === 0 && mode !== '--source') console.log('All skills are in place.');
process.exit(status);
