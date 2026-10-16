const { join } = require('node:path');
const { Arch } = require('builder-util');

async function setAndCheckFuses(context) {
  const { FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } = await import('@electron/fuses');
  const isMac = context.electronPlatformName === 'darwin';
  const checksAsarIntegrity = isMac || context.electronPlatformName === 'win32';
  const fuses = {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: isMac && context.arch === Arch.arm64,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: checksAsarIntegrity,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  };

  await context.packager.addElectronFuses(context, fuses);

  const executableName = context.electronPlatformName === 'linux'
    ? context.packager.executableName
    : context.packager.appInfo.productFilename;
  const extension = { darwin: '.app', win32: '.exe', linux: '' }[context.electronPlatformName];
  const electronPath = join(context.appOutDir, `${executableName}${extension}`);
  const fuseWire = await getCurrentFuseWire(electronPath);
  const requiredDisabled = [
    FuseV1Options.RunAsNode,
    FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    FuseV1Options.EnableNodeCliInspectArguments,
  ];
  for (const option of requiredDisabled) {
    if (fuseWire[option] !== FuseState.DISABLE) {
      throw new Error(`Electron fuse ${FuseV1Options[option]} was not disabled`);
    }
  }
  if (fuseWire[FuseV1Options.OnlyLoadAppFromAsar] !== FuseState.ENABLE) {
    throw new Error('Electron fuse OnlyLoadAppFromAsar was not enabled');
  }
  const expectedIntegrityFuse = checksAsarIntegrity ? FuseState.ENABLE : FuseState.DISABLE;
  if (fuseWire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] !== expectedIntegrityFuse) {
    throw new Error('Electron fuse EnableEmbeddedAsarIntegrityValidation has an unexpected state');
  }
}

module.exports = {
  appId: 'app.ligule.desktop',
  productName: 'ligule',
  electronDist: 'node_modules/electron/dist',
  // Electron Main/Renderer are JS-only. Core plus native bindings run in the separate pinned Node Host under extraResources.
  npmRebuild: false,
  asar: true,
  files: [
    'electron/dist/**/*.js',
    '!electron/dist/host-entry.js',
    '!electron/dist/test/**',
    'frontend/dist/**/*',
    'icons/**/*',
    'package.json',
    '!node_modules/**',
  ],
  extraResources: [
    { from: 'electron/dist/host-entry.js', to: 'host-entry.js' },
    { from: 'vendor/node', to: 'node' },
    { from: 'vendor/app', to: 'app' },
    { from: 'vendor/app/node_modules', to: 'app/node_modules' },
  ],
  directories: { output: 'release' },
  icon: 'icons/icon',
  afterPack: setAndCheckFuses,
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    signExecutable: false,
  },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  linux: {
    executableName: 'ligule',
    maintainer: 'xswt442-cmd <xswt442@gmail.com>',
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
    category: 'Utility',
  },
  mac: { target: [{ target: 'dmg' }], identity: null },
};
