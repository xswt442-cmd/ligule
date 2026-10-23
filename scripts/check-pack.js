// npm tarball 的文件白名单与入口检查。真实消费者安装和运行由 verify-install.js 覆盖。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { releaseManifest } from './pack-release.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const packDir = join(repo, 'testplace', 'pack');
const work = join(packDir, 'check');

if (!existsSync(join(repo, 'tui', 'dist', 'index.js')) || !existsSync(join(repo, 'core', 'dist', 'index.js'))) {
  throw new Error('TUI or Core build output is missing; run `pnpm run build` before checking the packaged artifact');
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
  if (manifest.bin?.ligule !== './dist/cli.js') throw new Error(`${tarball} is missing the ligule CLI entry required by the MCP server command`);
  if (JSON.stringify(manifest.dependencies) !== JSON.stringify(pkg.dependencies)) {
    throw new Error(`${tarball} does not carry the release manifest's dependencies`);
  }
  if (JSON.stringify(manifest.optionalDependencies) !== JSON.stringify(pkg.optionalDependencies)) {
    throw new Error(`${tarball} does not carry the release manifest's optional dependencies`);
  }
  const bundledCore = join(shipped, 'node_modules', '@ligule', 'core');
  if (!existsSync(join(bundledCore, 'dist', 'index.js')) || !existsSync(join(bundledCore, 'modes', 'minimal.toml'))
    || !existsSync(join(bundledCore, 'README.md')) || !existsSync(join(bundledCore, 'LICENSE'))) {
    throw new Error(`${tarball} is missing the bundled @ligule/core runtime, modes, README, or license`);
  }
  if (!existsSync(join(bundledCore, 'dist', 'host', 'control.js'))) {
    throw new Error(`${tarball} is missing the Host control module required by the MCP server`);
  }
  const coreManifest = JSON.parse(readFileSync(join(bundledCore, 'package.json'), 'utf8'));
  if (coreManifest.dependencies !== undefined || coreManifest.optionalDependencies !== undefined) {
    throw new Error(`${tarball} must declare external Core dependencies in the public package manifest`);
  }
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    if (name !== '@ligule/core' && existsSync(join(shipped, 'node_modules', name))) {
      throw new Error(`${tarball} must install ${name} on the consumer instead of bundling its build-platform tree`);
    }
  }
  for (const testPath of ['test', 'tests', 'core/test', 'tui/test']) {
    if (existsSync(join(shipped, testPath))) throw new Error(`${tarball} must not contain test files: ${testPath}`);
  }
  if (existsSync(join(bundledCore, 'test'))) throw new Error(`${tarball} must not bundle Core test fixtures`);
  const declared = [...collectTargets(manifest.exports), ...collectTargets(manifest.bin)];
  if (declared.length === 0) throw new Error('package.json declares neither exports nor bin, nothing to check');
  for (const target of declared) {
    if (!existsSync(join(shipped, target))) throw new Error(`${tarball} is missing ${target}, which package.json points at`);
  }
  process.stdout.write(`pack check ok: ${tarball}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
