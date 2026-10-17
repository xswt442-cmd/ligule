import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { assertSymlinksInside } from './runtime-tree.js';

const CORE_RUNTIME_PATHS = ['dist', 'modes', 'README.md', 'LICENSE'];
const REBUILD_GUIDANCE = 'Run `pnpm run build:core`, then `pnpm run prepare-runtime`.';

export async function assertCoreRuntimeMatches(sourceCore, deployedCore) {
  await assertCoreRoot(sourceCore, 'source');
  await assertCoreRoot(deployedCore, 'deployed');
  await Promise.all([
    assertCorePayloadSymlinks(sourceCore),
    assertCorePayloadSymlinks(deployedCore),
  ]);

  const [source, deployed] = await Promise.all([
    snapshotCore(sourceCore, true),
    snapshotCore(deployedCore, false),
  ]);
  const mismatches = [];
  const paths = new Set([...source.keys(), ...deployed.keys()]);
  for (const path of [...paths].sort()) {
    const sourceEntry = source.get(path);
    const deployedEntry = deployed.get(path);
    if (sourceEntry === undefined) mismatches.push(`unexpected ${path}`);
    else if (deployedEntry === undefined) mismatches.push(`missing ${path}`);
    else if (sourceEntry.type !== deployedEntry.type) mismatches.push(`type differs for ${path}`);
    else if (sourceEntry.type === 'file' && !sourceEntry.content.equals(deployedEntry.content)) mismatches.push(`content differs for ${path}`);
  }

  if (mismatches.length > 0) {
    throw new Error(`Core runtime does not match the built source (${mismatches.join(', ')}). ${REBUILD_GUIDANCE}`);
  }
}

async function assertCorePayloadSymlinks(coreRoot) {
  for (const path of ['dist', 'modes']) {
    const absolutePath = join(coreRoot, path);
    const info = await lstatOrMissing(absolutePath);
    if (info?.isDirectory()) await assertSymlinksInside(absolutePath);
  }
}

async function assertCoreRoot(directory, label) {
  let info;
  try {
    info = await stat(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    throw new Error(`Core ${label} directory is missing. ${REBUILD_GUIDANCE}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Core ${label} path must be a real directory. ${REBUILD_GUIDANCE}`);
  }
}

async function lstatOrMissing(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function snapshotCore(coreRoot, requireExpectedPaths) {
  const entries = new Map();
  for (const path of CORE_RUNTIME_PATHS) {
    const absolutePath = join(coreRoot, path);
    const info = await lstatOrMissing(absolutePath);
    if (info === null) {
      if (requireExpectedPaths) throw new Error(`built Core runtime is missing ${path}. ${REBUILD_GUIDANCE}`);
      continue;
    }
    if (info.isSymbolicLink()) throw new Error(`Core runtime contains a symbolic link at ${path}. ${REBUILD_GUIDANCE}`);
    if (path === 'README.md' || path === 'LICENSE') {
      if (!info.isFile()) throw new Error(`Core runtime metadata path is not a file: ${path}. ${REBUILD_GUIDANCE}`);
      entries.set(path, { type: 'file', content: await readFile(absolutePath) });
      continue;
    }
    if (!info.isDirectory()) throw new Error(`Core runtime path is not a directory: ${path}. ${REBUILD_GUIDANCE}`);
    await visit(absolutePath, path);
  }
  return entries;

  async function visit(directory, relativeDirectory) {
    entries.set(relativeDirectory, { type: 'directory' });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const childRelative = `${relativeDirectory}${sep}${entry.name}`;
      const child = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Core runtime contains a symbolic link at ${childRelative}. ${REBUILD_GUIDANCE}`);
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile()) entries.set(childRelative, { type: 'file', content: await readFile(child) });
      else throw new Error(`Core runtime contains an unsupported filesystem entry at ${childRelative}. ${REBUILD_GUIDANCE}`);
    }
  }
}
