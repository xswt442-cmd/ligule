import { readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const NATIVE_DIRECTORY = /^(linux|musl|darwin|win32|freebsd|android)[-_](x64|arm64|ia32|armhf|armv7l)$/;

export async function assertSymlinksInside(directory) {
  const root = await realpath(directory);
  await visit(root);

  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(child);
        const relativeTarget = relative(root, target);
        if (relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
          throw new Error(`runtime symlink escapes ${root}: ${child} -> ${target}`);
        }
      } else if (entry.isDirectory()) await visit(child);
    }
  }
}

export async function pruneForeignNativeDirectories(directory, target) {
  const nativeDirectory = target.replace('-', '_');
  await visit(directory);
  await assertNoForeignNativeDirectories(directory, target);

  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(path, entry.name);
      if (!keepNativeDirectory(entry.name, nativeDirectory)) {
        await rm(child, { recursive: true, force: true });
      } else await visit(child);
    }
  }
}

export async function assertNoForeignNativeDirectories(directory, target) {
  const nativeDirectory = target.replace('-', '_');
  await visit(directory);

  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!keepNativeDirectory(entry.name, nativeDirectory)) {
        throw new Error(`foreign native directory remains in the runtime tree: ${join(path, entry.name)}`);
      }
      await visit(join(path, entry.name));
    }
  }
}

function keepNativeDirectory(name, target) {
  if (name === 'obj.target') return false;
  const normalized = name.replaceAll('-', '_');
  return !NATIVE_DIRECTORY.test(normalized) || normalized === target;
}
