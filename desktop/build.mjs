import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePackageBin } from './package-bin.mjs';
import { assertCoreRuntimeMatches } from '../scripts/core-runtime.js';
import { assertNoForeignNativeDirectories, assertSymlinksInside } from '../scripts/runtime-tree.js';

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(desktopRoot);
const rootRequire = createRequire(join(repositoryRoot, 'package.json'));
const desktopRequire = createRequire(join(desktopRoot, 'package.json'));
const frontendRequire = createRequire(join(desktopRoot, 'frontend', 'package.json'));
const buildArguments = process.argv.slice(2);
const requestedArchitectures = getRequestedArchitectures(buildArguments);

if (process.platform !== 'darwin' && process.arch !== 'x64') {
  throw new Error(`desktop packaging supports only x64 on ${process.platform}`);
}
if (process.platform === 'darwin' && process.arch !== 'arm64' && process.arch !== 'x64') {
  throw new Error(`desktop packaging does not support ${process.platform}-${process.arch}`);
}
if (requestedArchitectures.size > 1 || [...requestedArchitectures].some((arch) => arch !== process.arch)) {
  throw new Error(`the desktop runtime is prepared for ${process.platform}-${process.arch}; requested architecture flags: ${[...requestedArchitectures].join(', ')}`);
}

function getRequestedArchitectures(args) {
  const requested = new Set();
  const namedArchitectures = new Map([
    ['--x64', 'x64'],
    ['--ia32', 'ia32'],
    ['--arm64', 'arm64'],
    ['--universal', 'universal'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const namedArchitecture = namedArchitectures.get(argument);
    if (namedArchitecture !== undefined) requested.add(namedArchitecture);
    else if (argument === '--arch') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--arch requires an architecture');
      for (const arch of value.split(',')) requested.add(arch);
      index += 1;
    } else if (argument.startsWith('--arch=')) {
      for (const arch of argument.slice('--arch='.length).split(',')) requested.add(arch);
    }
  }
  return requested;
}

function run(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const runtimePaths = [
  join(desktopRoot, 'vendor', 'node'),
  join(desktopRoot, 'vendor', 'app'),
  join(desktopRoot, 'vendor', 'node', '.vendored'),
];
const missingRuntimePaths = runtimePaths.filter((path) => !existsSync(path));
if (missingRuntimePaths.length > 0) {
  throw new Error(`desktop runtime resources are missing: ${missingRuntimePaths.join(', ')}`);
}
await assertSymlinksInside(join(desktopRoot, 'vendor', 'app'));
await assertNoForeignNativeDirectories(join(desktopRoot, 'vendor', 'app', 'node_modules'), `${process.platform}-${process.arch}`);
await assertCoreRuntimeMatches(
  join(repositoryRoot, 'core'),
  join(desktopRoot, 'vendor', 'app', 'node_modules', '@ligule', 'core'),
);
const runtimeStamp = readFileSync(join(desktopRoot, 'vendor', 'node', '.vendored'), 'utf8').trim();
if (!runtimeStamp.startsWith(`${process.platform}-${process.arch}:`)) {
  throw new Error(`the vendored Node runtime targets ${runtimeStamp}; expected ${process.platform}-${process.arch}`);
}

run([
  resolvePackageBin(rootRequire, 'typescript', 'tsc'),
  '-p',
  join(desktopRoot, 'electron', 'tsconfig.json'),
], desktopRoot);
const hostEntry = join(desktopRoot, 'electron', 'dist', 'host-entry.js');
if (!existsSync(hostEntry)) throw new Error(`compiled Host entry is missing: ${hostEntry}`);
run([
  resolvePackageBin(frontendRequire, 'typescript', 'tsc'),
  '--noEmit',
], join(desktopRoot, 'frontend'));
run([
  resolvePackageBin(frontendRequire, 'vite'),
  'build',
], join(desktopRoot, 'frontend'));
run([
  resolvePackageBin(desktopRequire, 'electron-builder'),
  '--config',
  join(desktopRoot, 'electron-builder.cjs'),
  '--publish',
  'never',
  ...(requestedArchitectures.size === 0 ? [`--${process.arch}`] : []),
  ...buildArguments,
], desktopRoot);
