import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;

export function releaseManifest() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const pin = JSON.parse(readFileSync(join(root, 'scripts', 'ripgrep-pin.json'), 'utf8'));
  const targets = Object.entries(pin.targets);
  if (targets.length !== 4) throw new Error(`expected four pinned search packages, found ${targets.length}`);
  const optionalDependencies = { ...(manifest.optionalDependencies ?? {}) };
  const declaredSearchPackages = Object.keys(optionalDependencies).filter((name) => name.startsWith('ligule-rg-'));
  if (declaredSearchPackages.length > 0) {
    throw new Error(`source package.json must not declare unpublished search packages: ${declaredSearchPackages.join(', ')}`);
  }
  const names = new Set();
  for (const [targetName, target] of targets) {
    if (names.has(target.package)) throw new Error(`duplicate search package ${target.package}`);
    names.add(target.package);
    const [platform, architecture] = targetName.split('-');
    const platformManifest = JSON.parse(readFileSync(join(root, 'packages', target.directory, 'package.json'), 'utf8'));
    if (platformManifest.name !== target.package || !target.package.startsWith(`${manifest.name}-rg-`)) {
      throw new Error(`${target.directory} must be named ${target.package}`);
    }
    if (platformManifest.version !== manifest.version) {
      throw new Error(`${target.package} must use ligule version ${manifest.version}`);
    }
    if (platformManifest.os?.length !== 1 || platformManifest.os[0] !== platform
      || platformManifest.cpu?.length !== 1 || platformManifest.cpu[0] !== architecture) {
      throw new Error(`${target.package} platform restrictions do not match ${targetName}`);
    }
    optionalDependencies[target.package] = manifest.version;
  }
  return { ...manifest, optionalDependencies };
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
  if (!npmCli) throw new Error('run through npm so npm_execpath identifies npm on this platform');
  const finalManifest = releaseManifest();
  const destinationDirectory = resolve(root, destination);
  await mkdir(join(root, 'testplace', 'tmp'), { recursive: true });
  const temporaryRoot = await mkdtemp(join(root, 'testplace', 'tmp', 'release-pack-'));
  const stagedPackage = join(temporaryRoot, 'package');
  try {
    const dryRun = execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], {
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
    const finalOutput = execFileSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', destinationDirectory], {
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
  if (process.argv.length > 3) throw new Error('usage: npm run pack-release -- [destination]');
  await packRelease(destination);
}
