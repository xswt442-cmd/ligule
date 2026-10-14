// npm tarball 的文件白名单与入口检查。真实消费者安装和运行由 verify-install.js 覆盖。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { releaseManifest } from './pack-release.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const packDir = join(repo, 'testplace', 'pack');
const work = join(packDir, 'check');

if (!existsSync(join(repo, 'dist', 'index.js'))) {
  throw new Error('dist/index.js is missing; run `pnpm --filter ligule run build` before checking the packaged artifact');
}

function collectTargets(value, found = []) {
  if (typeof value === 'string') found.push(value);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectTargets(item, found);
  return found;
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

try {
  const pkg = releaseManifest();
  const tarball = `${pkg.name}-${pkg.version}.tgz`;
  mkdirSync(packDir, { recursive: true });
  execFileSync(process.execPath, [join(repo, 'scripts', 'pack-release.js'), 'testplace/pack'], { cwd: repo, stdio: 'inherit' });
  if (!existsSync(join(packDir, tarball))) throw new Error(`npm pack did not produce testplace/pack/${tarball}`);

  execFileSync('tar', ['-xzf', `testplace/pack/${tarball}`, '-C', 'testplace/pack/check'], { cwd: repo, stdio: 'inherit' });
  const shipped = join(work, 'package');
  const manifest = JSON.parse(readFileSync(join(shipped, 'package.json'), 'utf8'));
  if (JSON.stringify(manifest.dependencies) !== JSON.stringify(pkg.dependencies)) {
    throw new Error(`${tarball} does not carry the release manifest's dependencies`);
  }
  if (JSON.stringify(manifest.optionalDependencies) !== JSON.stringify(pkg.optionalDependencies)) {
    throw new Error(`${tarball} does not carry the release manifest's optional dependencies`);
  }
  const declared = [...collectTargets(manifest.exports), ...collectTargets(manifest.bin)];
  if (declared.length === 0) throw new Error('package.json declares neither exports nor bin, nothing to check');
  for (const target of declared) {
    if (!existsSync(join(shipped, target))) throw new Error(`${tarball} is missing ${target}, which package.json points at`);
  }
  process.stdout.write(`pack check ok: ${tarball}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
