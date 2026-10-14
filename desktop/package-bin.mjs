import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function resolvePackageBin(requireFrom, packageName, binaryName = packageName) {
  let directory = dirname(requireFrom.resolve(packageName));
  while (true) {
    const manifestPath = join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.name === packageName) {
        const binary = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binaryName];
        if (typeof binary !== 'string') throw new Error(`${packageName} does not declare the ${binaryName} executable`);
        return resolve(directory, binary);
      }
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`could not locate the package manifest for ${packageName}`);
    directory = parent;
  }
}
