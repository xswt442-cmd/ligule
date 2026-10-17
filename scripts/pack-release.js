import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertCoreRuntimeMatches } from './core-runtime.js';
import { assertSymlinksInside } from './runtime-tree.js';

const root = fileURLToPath(new URL('..', import.meta.url));

export function releaseManifest() {
  const manifest = JSON.parse(readFileSync(join(root, 'tui', 'package.json'), 'utf8'));
  delete manifest.packageManager;
  const core = JSON.parse(readFileSync(join(root, 'core', 'package.json'), 'utf8'));
  if (typeof core.dependencies?.['@vscode/ripgrep'] !== 'string') {
    throw new Error('core/package.json must declare @vscode/ripgrep as a runtime dependency');
  }
  const declaredSearchPackages = Object.keys(manifest.optionalDependencies ?? {}).filter((name) => name.startsWith('ligule-rg-'));
  if (declaredSearchPackages.length > 0) {
    throw new Error(`package.json must not declare local search platform packages: ${declaredSearchPackages.join(', ')}`);
  }
  manifest.dependencies['@ligule/core'] = '*';
  return manifest;
}

function deployTui(target) {
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli === undefined || !pnpmCli.toLowerCase().includes('pnpm')) throw new Error('run package packing through the pinned pnpm workspace command');
  const args = ['--filter=ligule', 'deploy', '--prod', target];
  const isJavaScriptCli = /\.(?:cjs|mjs|js)$/i.test(pnpmCli);
  execFileSync(isJavaScriptCli ? process.execPath : pnpmCli, isJavaScriptCli ? [pnpmCli, ...args] : args, { cwd: root, stdio: 'inherit' });
}

function execPnpm(args, options) {
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli === undefined || !pnpmCli.toLowerCase().includes('pnpm')) throw new Error('run package packing through the pinned pnpm workspace command');
  const isJavaScriptCli = /\.(?:cjs|mjs|js)$/i.test(pnpmCli);
  return execFileSync(isJavaScriptCli ? process.execPath : pnpmCli, isJavaScriptCli ? [pnpmCli, ...args] : args, options);
}

function packInfo(output, label) {
  const parsed = JSON.parse(output);
  const info = Array.isArray(parsed) && parsed.length === 1 ? parsed[0]
    : Array.isArray(parsed?.files) ? parsed
      : parsed?.[releaseManifest().name];
  if (!Array.isArray(info?.files) || typeof info.filename !== 'string') {
    throw new Error(`npm pack ${label} did not return its file list and archive name`);
  }
  return info;
}

export async function packRelease(destination) {
  const finalManifest = releaseManifest();
  const destinationDirectory = resolve(root, destination);
  await mkdir(join(root, 'testplace', 'tmp'), { recursive: true });
  const temporaryRoot = await mkdtemp(join(root, 'testplace', 'tmp', 'release-pack-'));
  const stagedPackage = join(temporaryRoot, 'package');
  try {
    deployTui(stagedPackage);
    await assertSymlinksInside(stagedPackage);
    await assertCoreRuntimeMatches(join(root, 'core'), join(stagedPackage, 'node_modules', '@ligule', 'core'));
    await writeFile(join(stagedPackage, 'package.json'), `${JSON.stringify(finalManifest, null, 2)}\n`, 'utf8');
    const dryRun = execPnpm(['--dir', stagedPackage, 'pack', '--dry-run', '--json', '--ignore-workspace'], { cwd: root, encoding: 'utf8' });
    const sourceInfo = packInfo(dryRun, 'deployed dry run');
    const included = new Set(sourceInfo.files.map(({ path }) => path));
    if (!included.has('package.json')) throw new Error('deployed package is missing package.json');
    await mkdir(destinationDirectory, { recursive: true });
    const finalOutput = execPnpm(['--dir', stagedPackage, 'pack', '--json', '--pack-destination', destinationDirectory, '--ignore-workspace'], { cwd: root, encoding: 'utf8' });
    const finalInfo = packInfo(finalOutput, 'staged package');
    const tarball = isAbsolute(finalInfo.filename) ? finalInfo.filename : join(destinationDirectory, finalInfo.filename);
    if (!existsSync(tarball)) throw new Error(`npm pack did not produce ${tarball}`);
    const stagedPaths = finalInfo.files.map(({ path }) => path).sort();
    if (JSON.stringify(stagedPaths) !== JSON.stringify([...included].sort())) throw new Error('the staged tarball file list differs from npm pack --dry-run');
    process.stdout.write(`${tarball}\n`);
    return tarball;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2] ?? 'testplace/pack';
  if (process.argv.length > 3) throw new Error('usage: pnpm --filter ligule run pack-release [destination]');
  await packRelease(destination);
}
