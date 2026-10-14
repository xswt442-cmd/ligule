import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execNpm } from './npm-cli.js';

const root = fileURLToPath(new URL('..', import.meta.url));

export function releaseManifest() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  delete manifest.packageManager;
  if (typeof manifest.dependencies?.['@vscode/ripgrep'] !== 'string') {
    throw new Error('package.json must declare @vscode/ripgrep as a runtime dependency');
  }
  const declaredSearchPackages = Object.keys(manifest.optionalDependencies ?? {}).filter((name) => name.startsWith('ligule-rg-'));
  if (declaredSearchPackages.length > 0) {
    throw new Error(`package.json must not declare local search platform packages: ${declaredSearchPackages.join(', ')}`);
  }
  return manifest;
}

function packInfo(output, label) {
  const parsed = JSON.parse(output);
  const info = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed?.[releaseManifest().name];
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
    const dryRun = execNpm(['pack', '--dry-run', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    const sourceInfo = packInfo(dryRun, 'dry run');
    const included = new Set();
    for (const entry of sourceInfo.files) {
      const source = resolve(root, entry.path);
      const relativeSource = relative(root, source);
      if (relativeSource === '' || relativeSource === '..' || relativeSource.startsWith(`..${sep}`) || isAbsolute(relativeSource)) {
        throw new Error(`npm pack returned a path outside the repository: ${entry.path}`);
      }
      if (included.has(entry.path)) throw new Error(`npm pack returned ${entry.path} more than once`);
      included.add(entry.path);
      await mkdir(dirname(join(stagedPackage, entry.path)), { recursive: true });
      await copyFile(source, join(stagedPackage, entry.path));
      if (Number.isInteger(entry.mode)) await chmod(join(stagedPackage, entry.path), entry.mode);
    }
    if (!included.has('package.json')) throw new Error('npm pack did not include package.json');
    await writeFile(join(stagedPackage, 'package.json'), `${JSON.stringify(finalManifest, null, 2)}\n`, 'utf8');
    await mkdir(destinationDirectory, { recursive: true });
    const finalOutput = execNpm(['pack', '--json', '--pack-destination', destinationDirectory], {
      cwd: stagedPackage,
      encoding: 'utf8',
    });
    const finalInfo = packInfo(finalOutput, 'staged package');
    const tarball = join(destinationDirectory, finalInfo.filename);
    if (!existsSync(tarball)) throw new Error(`npm pack did not produce ${tarball}`);
    const stagedPaths = finalInfo.files.map(({ path }) => path).sort();
    const sourcePaths = [...included].sort();
    if (JSON.stringify(stagedPaths) !== JSON.stringify(sourcePaths)) {
      throw new Error('the staged tarball file list differs from npm pack --dry-run');
    }
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
