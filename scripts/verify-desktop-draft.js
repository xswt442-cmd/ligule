import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGETS = {
  'linux-x64': ['.AppImage', '.deb'],
  'windows-x64': ['.exe'],
};

// GitHub 上传 Release 资产时会将文件名中的空格替换为句点。
export function githubAssetName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('/') || name.includes('\\')) {
    throw new Error('invalid release asset name');
  }
  return name.replace(/\s/g, '.');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameMembers(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function verifyDesktopDraft(directory, tag, commit) {
  if (!/^desktop-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw new Error('invalid Desktop tag');
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('invalid Desktop source commit');
  const version = tag.slice('desktop-v'.length);
  const manifest = JSON.parse(readFileSync(join(directory, 'desktop-release-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.product !== 'desktop' || manifest.tag !== tag
    || manifest.version !== version || manifest.sourceCommit !== commit) {
    throw new Error('draft manifest does not match the requested tag and source commit');
  }
  const expectedTargets = Object.keys(TARGETS).sort();
  if (!Array.isArray(manifest.targets)
    || !sameMembers(manifest.targets.map(({ target, architecture }) =>
      architecture === 'x64' ? target : 'invalid-architecture').sort(), expectedTargets)) {
    throw new Error('draft manifest has invalid target set');
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== 3) {
    throw new Error('draft manifest must contain exactly three installer assets');
  }

  const expectedFiles = new Set(['SHA256SUMS', 'desktop-release-manifest.json']);
  const checksums = [];
  for (const target of expectedTargets) {
    const extensions = TARGETS[target];
    const targetAssets = manifest.assets.filter((asset) => asset.target === target);
    if (targetAssets.length !== extensions.length) throw new Error(`invalid asset count for ${target}`);
    for (const extension of extensions) {
      const matches = targetAssets.filter((asset) => typeof asset.name === 'string' && asset.name.endsWith(extension));
      if (matches.length !== 1) throw new Error(`missing or duplicate ${target} ${extension}`);
    }
  }

  for (const asset of manifest.assets) {
    const prefix = `ligule-desktop-v${version}-${asset.target}-${commit.slice(0, 12)}-`;
    if (asset.architecture !== 'x64' || !Object.hasOwn(TARGETS, asset.target)
      || !asset.name.startsWith(prefix) || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
      throw new Error('draft contains a malformed installer identity');
    }
    const uploadedName = githubAssetName(asset.name);
    if (expectedFiles.has(uploadedName)) throw new Error(`duplicate GitHub Release asset: ${uploadedName}`);
    expectedFiles.add(uploadedName);
    const content = readFileSync(join(directory, uploadedName));
    if (sha256(content) !== asset.sha256) throw new Error(`draft asset SHA-256 mismatch: ${uploadedName}`);
    checksums.push(`${asset.sha256}  ${asset.name}`);
  }

  const actualFiles = readdirSync(directory).sort();
  if (!sameMembers(actualFiles, [...expectedFiles].sort())) {
    throw new Error('draft Release contains missing or unexpected assets');
  }
  const actualChecksums = readFileSync(join(directory, 'SHA256SUMS'), 'utf8');
  if (actualChecksums !== `${checksums.sort().join('\n')}\n`) {
    throw new Error('draft SHA256SUMS does not match the manifest');
  }
  return { tag, sourceCommit: commit, assets: expectedFiles.size - 2 };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, tag, commit] = process.argv.slice(2);
  if (directory === undefined || tag === undefined || commit === undefined || process.argv.length !== 5) {
    throw new Error('usage: node scripts/verify-desktop-draft.js <directory> <desktop-vX.Y.Z> <source-sha>');
  }
  process.stdout.write(`${JSON.stringify(verifyDesktopDraft(resolve(directory), tag, commit))}\n`);
}
