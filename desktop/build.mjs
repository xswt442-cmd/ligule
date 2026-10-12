// 桌面安装包构建入口：Linux AppImage 的 linuxdeploy 会改写静态 ripgrep 的 ELF 头，
// 因此在 AppImage 打包后用同一份上游二进制恢复 AppDir，再由官方输出插件重新封装。
import { chmod, copyFile, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(desktopRoot, '..');
const tauriCli = join(desktopRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const tauri = spawnSync(process.execPath, [tauriCli, 'build', ...process.argv.slice(2)], {
  cwd: desktopRoot,
  stdio: 'inherit',
});
if (tauri.error !== undefined) throw tauri.error;
if (tauri.status !== 0) process.exit(tauri.status ?? 1);

if (process.platform === 'linux') await repairAppImageRipgrep();

async function repairAppImageRipgrep() {
  const bundle = join(desktopRoot, 'src-tauri', 'target', 'release', 'bundle', 'appimage');
  if (!existsSync(bundle)) return;
  const names = (await readdir(bundle)).filter((name) => name.endsWith('.AppImage'));
  if (names.length === 0) return;
  if (names.length !== 1) throw new Error('expected one AppImage in ' + bundle + ', found ' + names.length);

  const appDir = join(bundle, 'ligule.AppDir');
  const app = join(appDir, 'usr', 'lib', 'ligule', 'app');
  const searchBinary = join(app, 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg');
  const upstreamBinary = join(desktopRoot, 'vendor', 'app', 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg');
  const plugin = join(homedir(), '.cache', 'tauri', 'linuxdeploy-plugin-appimage.AppImage');
  if (!existsSync(appDir) || !existsSync(upstreamBinary) || !existsSync(plugin)) {
    throw new Error('the AppImage AppDir, upstream ripgrep binary, or Tauri AppImage plugin is missing');
  }

  const scratchRoot = join(repositoryRoot, 'testplace', 'tmp');
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(join(scratchRoot, 'appimage-ripgrep-'));
  try {
    await copyFile(upstreamBinary, searchBinary);
    await chmod(searchBinary, 0o755);
    const version = execFileSync(searchBinary, ['--version'], { encoding: 'utf8' }).trim();
    if (!version.startsWith('ripgrep ')) throw new Error('the restored search binary reported "' + version + '"');

    const image = join(bundle, names[0]);
    const rebuilt = join(scratch, basename(image));
    execFileSync(plugin, ['--appdir', appDir], {
      cwd: bundle,
      env: {
        ...process.env,
        APPIMAGE_EXTRACT_AND_RUN: '1',
        ARCH: 'x86_64',
        LDAI_OUTPUT: rebuilt,
        OUTPUT: rebuilt,
      },
      stdio: 'inherit',
    });
    if ((await stat(rebuilt)).size === 0) throw new Error('the repaired AppImage is empty');
    await rename(rebuilt, image);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
