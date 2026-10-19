import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGETS = {
  'windows-x64': { extensions: ['.exe'], architecture: 'x64' },
  'linux-x64': { extensions: ['.AppImage', '.deb'], architecture: 'x64' },
} as const;

type DesktopTarget = keyof typeof TARGETS;
type ReleaseAsset = { name: string; sha256: string; target?: DesktopTarget; architecture?: string };
type TargetReleaseManifest = {
  schemaVersion: 1;
  product: 'desktop';
  tag: string;
  version: string;
  architecture: string;
  target: DesktopTarget;
  sourceCommit: string;
  workflowRunId: string;
  assets: ReleaseAsset[];
};

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function requireTarget(target: string): typeof TARGETS[DesktopTarget] {
  if (!Object.hasOwn(TARGETS, target)) throw new Error(`unsupported desktop target: ${target}`);
  const config = TARGETS[target as DesktopTarget];
  return config;
}

export function createDesktopReleaseManifest({
  directory,
  outputDirectory = directory,
  version,
  target,
  commit,
  runId,
}: {
  directory: string;
  outputDirectory?: string;
  version: string;
  target: string;
  commit: string;
  runId: string | number;
}): TargetReleaseManifest {
  const config = requireTarget(target);
  mkdirSync(outputDirectory, { recursive: true });
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error(`invalid version: ${version}`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`invalid source commit: ${commit}`);
  if (!/^\d+$/.test(String(runId))) throw new Error(`invalid workflow run ID: ${runId}`);
  const files = readdirSync(directory).filter((name) => config.extensions.some((extension) => name.endsWith(extension)));
  for (const extension of config.extensions) {
    const matches = files.filter((name) => name.endsWith(extension));
    if (matches.length !== 1) {
      throw new Error(`${target} must produce exactly one ${extension} installer; found ${matches.length}`);
    }
  }
  const assets = files.sort().map((name) => {
    if (!name.includes(version)) throw new Error(`${name} does not identify desktop version ${version}`);
    const source = join(directory, name);
    const publishedName = `ligule-desktop-v${version}-${target}-${commit.slice(0, 12)}-${basename(name)}`;
    const destination = join(outputDirectory, publishedName);
    copyFileSync(source, destination);
    return { name: publishedName, sha256: sha256(destination) };
  });
  const manifest = {
    schemaVersion: 1 as const,
    product: 'desktop' as const,
    tag: `desktop-v${version}`,
    version,
    architecture: config.architecture,
    target: target as DesktopTarget,
    sourceCommit: commit,
    workflowRunId: String(runId),
    assets,
  };
  writeFileSync(join(outputDirectory, `desktop-release-manifest-${target}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(outputDirectory, `SHA256SUMS-${target}`), `${assets.map(({ name, sha256: digest }) => `${digest}  ${name}`).join('\n')}\n`);
  return manifest;
}

export function verifyDesktopReleaseManifests({ directory, version, commit, runId }: {
  directory: string;
  version: string;
  commit: string;
  runId: string | number;
}): { targets: DesktopTarget[]; assets: string[] } {
  const expectedTargets = Object.keys(TARGETS).sort() as DesktopTarget[];
  const allowedRootFiles = new Set(['SHA256SUMS', 'desktop-release-manifest.json']);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !expectedTargets.includes(entry.name as DesktopTarget)) {
      throw new Error(`unexpected Desktop release target: ${entry.name}`);
    }
    if (!entry.isDirectory() && !allowedRootFiles.has(entry.name)) {
      throw new Error(`unexpected file in Desktop release set: ${entry.name}`);
    }
  }
  const manifests = expectedTargets.map((expectedTarget) => {
    const manifestPath = join(directory, expectedTarget, `desktop-release-manifest-${expectedTarget}.json`);
    try {
      return {
        expectedTarget,
        directory: join(directory, expectedTarget),
        value: JSON.parse(readFileSync(manifestPath, 'utf8')) as TargetReleaseManifest,
      };
    } catch (error) {
      throw new Error(`missing or invalid manifest for ${expectedTarget}`, { cause: error });
    }
  });
  const targets = manifests.map(({ value }) => value.target);
  const names = new Set<string>();
  const checksums = [];
  const consolidatedAssets: (ReleaseAsset & { target: DesktopTarget; architecture: string })[] = [];
  for (const { expectedTarget, directory: targetDirectory, value: manifest } of manifests) {
    const config = requireTarget(manifest.target);
    if (manifest.schemaVersion !== 1 || manifest.product !== 'desktop' || manifest.target !== expectedTarget
      || manifest.tag !== `desktop-v${version}` || manifest.version !== version
      || manifest.architecture !== config.architecture || manifest.sourceCommit !== commit
      || manifest.workflowRunId !== String(runId) || !Array.isArray(manifest.assets)) {
      throw new Error(`manifest for ${manifest.target} does not match the verified tag workflow source`);
    }
    if (manifest.assets.length !== config.extensions.length) throw new Error(`manifest for ${manifest.target} has an unexpected installer count`);
    for (const extension of config.extensions) {
      const matches = manifest.assets.filter((asset) => asset.name.endsWith(extension));
      if (matches.length !== 1) throw new Error(`manifest for ${manifest.target} must contain exactly one ${extension} installer`);
    }
    for (const asset of manifest.assets) {
      if (!config.extensions.some((extension) => asset.name.endsWith(extension))) {
        throw new Error(`unexpected installer type for ${manifest.target}: ${asset.name}`);
      }
      if (names.has(asset.name)) throw new Error(`duplicate installer asset: ${asset.name}`);
      names.add(asset.name);
      const path = join(targetDirectory, asset.name);
      if (sha256(path) !== asset.sha256) throw new Error(`installer checksum mismatch: ${asset.name}`);
      if (!asset.name.includes(`desktop-v${version}-${manifest.target}-${commit.slice(0, 12)}-`)) {
        throw new Error(`installer filename does not encode its version, architecture target, and source SHA: ${asset.name}`);
      }
      // GitHub 上传 Release 资产时会把空白替换成点号；校验文件也使用下载后的文件名。
      checksums.push(`${asset.sha256}  ${asset.name.replace(/\s/g, '.')}`);
      consolidatedAssets.push({ ...asset, target: manifest.target, architecture: manifest.architecture });
    }
    const allowedFiles = new Set([
      ...manifest.assets.map(({ name }) => name),
      `desktop-release-manifest-${manifest.target}.json`,
      `SHA256SUMS-${manifest.target}`,
    ]);
    for (const entry of readdirSync(targetDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !allowedFiles.has(entry.name)) {
        throw new Error(`unexpected file for ${manifest.target}: ${entry.name}`);
      }
    }
  }
  writeFileSync(join(directory, 'SHA256SUMS'), `${checksums.sort().join('\n')}\n`);
  writeFileSync(join(directory, 'desktop-release-manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    product: 'desktop',
    tag: `desktop-v${version}`,
    version,
    sourceCommit: commit,
    targets: manifests.map(({ value }) => ({ target: value.target, architecture: value.architecture })),
    assets: consolidatedAssets.sort((left, right) => left.name.localeCompare(right.name)),
  }, null, 2)}\n`);
  return { targets, assets: [...names].sort() };
}

function argumentsMap(args: string[]): Map<string, string> {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith('--') || args[index + 1] === undefined) throw new Error(`invalid argument near ${args[index]}`);
    options.set(args[index].slice(2), args[index + 1]);
  }
  return options;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const options = argumentsMap(args);
  const directory = resolve(options.get('directory') ?? 'desktop/release');
  const outputDirectory = resolve(options.get('output') ?? directory);
  if (command === 'create') {
    const manifest = createDesktopReleaseManifest({
      directory,
      outputDirectory,
      version: options.get('version') as string,
      target: options.get('target') as string,
      commit: options.get('commit') as string,
      runId: options.get('run-id') as string,
    });
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  } else if (command === 'verify') {
    const result = verifyDesktopReleaseManifests({
      directory,
      version: options.get('version') as string,
      commit: options.get('commit') as string,
      runId: options.get('run-id') as string,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    throw new Error('usage: node --experimental-strip-types scripts/desktop-release-manifest.ts <create|verify> --directory PATH --version X.Y.Z --target TARGET --commit SHA --run-id ID');
  }
}
