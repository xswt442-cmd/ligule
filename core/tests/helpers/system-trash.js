import assert from 'node:assert/strict';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

async function mountPointFor(target) {
  let current = resolve(target);
  let currentStat;
  try { currentStat = await stat(current); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    current = dirname(current);
    currentStat = await stat(current);
  }
  for (;;) {
    const parent = dirname(current);
    if (parent === current || (await stat(parent)).dev !== currentStat.dev) return current;
    current = parent;
  }
}

async function trashRootsFor(target) {
  const absoluteTarget = resolve(target);
  const mountPoint = await mountPointFor(absoluteTarget);
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const uid = String(process.getuid());
  return [
    { root: join(dataHome, 'Trash'), originalPath: absoluteTarget },
    { root: join(mountPoint, `.Trash-${uid}`), originalPath: relative(mountPoint, absoluteTarget) },
    { root: join(mountPoint, '.Trash', uid), originalPath: relative(mountPoint, absoluteTarget) },
  ];
}

function encodeTrashPath(path) {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

export async function findSystemTrashEntry(target, { allowSuffix = false, root } = {}) {
  const name = basename(resolve(target));
  const candidates = (await trashRootsFor(target)).filter((candidate) => root === undefined || candidate.root === root);
  for (const candidate of candidates) {
    const infoDirectory = join(candidate.root, 'info');
    const suffixStem = basename(resolve(target), extname(name));
    let infoNames;
    try {
      infoNames = allowSuffix
        ? (await readdir(infoDirectory)).filter((entry) => entry.startsWith(suffixStem) && entry.endsWith('.trashinfo'))
        : [`${name}.trashinfo`];
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    for (const infoName of infoNames) {
      const infoPath = join(infoDirectory, infoName);
      let info;
      try { info = await readFile(infoPath, 'utf8'); }
      catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
        throw error;
      }
      const original = info.match(/^Path=(.*)$/m)?.[1];
      const acceptedPaths = new Set([candidate.originalPath, encodeTrashPath(candidate.originalPath)]);
      let decoded;
      try { decoded = original?.split('/').map(decodeURIComponent).join('/'); }
      catch { decoded = undefined; }
      if (original === undefined || (!acceptedPaths.has(original) && !acceptedPaths.has(decoded))) continue;
      const payloadName = infoName.slice(0, -'.trashinfo'.length);
      return { root: candidate.root, infoPath, payloadPath: join(candidate.root, 'files', payloadName) };
    }
  }
  return undefined;
}

export async function removeSystemTrashEntry(entry, expected) {
  if (expected.type === 'file') {
    assert.equal(await readFile(entry.payloadPath, 'utf8'), expected.content);
  } else {
    assert.equal(await readFile(join(entry.payloadPath, ...expected.relativePath), 'utf8'), expected.content);
  }
  await rm(entry.payloadPath, { recursive: expected.type === 'directory' });
  await rm(entry.infoPath);
}

export async function cleanSystemTrashEntry(target, expected, { allowSuffix = false, required = false, root } = {}) {
  const entry = await findSystemTrashEntry(target, { allowSuffix, root });
  if (entry === undefined) {
    if (required) assert.fail(`system trash did not expose the item created for ${target}`);
    return;
  }
  await removeSystemTrashEntry(entry, expected);
}
