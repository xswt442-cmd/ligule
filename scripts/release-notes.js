import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const RELEASE_TAG = /^(cli|desktop)-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = `## [${version}]`;
  const starts = lines.flatMap((line, index) => line === heading || line.startsWith(`${heading} - `) ? [index] : []);
  if (starts.length !== 1) throw new Error(`changelog must have exactly one ${version} section`);
  const start = starts[0];
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const content = lines.slice(start + 1, next < 0 ? lines.length : next).join('\n').trim();
  const sectionLines = content.split('\n');
  for (const language of ['### 简体中文', '### English']) {
    const position = sectionLines.indexOf(language);
    const nextHeading = sectionLines.findIndex((line, index) => index > position && line.startsWith('### '));
    if (position < 0 || sectionLines.slice(position + 1, nextHeading < 0 ? sectionLines.length : nextHeading)
      .every((line) => line.trim().length === 0)) {
      throw new Error(`changelog ${version} section needs content under ${language}`);
    }
  }
  return content;
}

export function parseReleaseTag(tag) {
  const match = RELEASE_TAG.exec(tag);
  if (match === null) throw new Error(`release tag must use cli-vX.Y.Z or desktop-vX.Y.Z form: ${tag}`);
  return { product: match[1], version: `${match[2]}.${match[3]}.${match[4]}` };
}

const RELEASE_ROOT = 'https://github.com/xswt442-cmd/ligule/releases';
const DESKTOP_PACKAGES = [
  { target: 'windows-x64', extension: '.exe', os: 'Windows x64', format: 'NSIS (.exe)', purpose: '安装向导 / Installer wizard' },
  { target: 'linux-x64', extension: '.AppImage', os: 'Linux x64', format: 'AppImage', purpose: '免安装运行 / Portable app' },
  { target: 'linux-x64', extension: '.deb', os: 'Linux x64', format: 'deb (.deb)', purpose: 'Debian/Ubuntu 系发行版 / Debian/Ubuntu-based' },
];

function verifiedDownloadAssets(tag, manifest) {
  if (manifest === undefined) return undefined;
  const { version } = parseReleaseTag(tag);
  if (manifest.schemaVersion !== 1 || manifest.product !== 'desktop' || manifest.tag !== tag
    || manifest.version !== version || !/^[0-9a-f]{40}$/.test(manifest.sourceCommit)
    || !Array.isArray(manifest.assets) || manifest.assets.length !== DESKTOP_PACKAGES.length) {
    throw new Error('Desktop release notes require a verified manifest for this exact tag');
  }
  const prefix = `ligule-desktop-v${version}-`;
  const selected = [];
  for (const item of DESKTOP_PACKAGES) {
    const candidates = manifest.assets.filter((asset) => asset.target === item.target
      && asset.architecture === 'x64' && asset.name?.endsWith(item.extension));
    if (candidates.length !== 1) throw new Error(`missing or duplicate Desktop asset: ${item.target} ${item.extension}`);
    const asset = candidates[0];
    if (typeof asset.name !== 'string' || !asset.name.startsWith(`${prefix}${item.target}-${manifest.sourceCommit.slice(0, 12)}-`)
      || asset.name.includes('/') || asset.name.includes('\\')
      || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
      throw new Error('Desktop release notes found an invalid asset identity');
    }
    selected.push(asset);
  }
  return selected;
}

export function desktopDownloadTable(tag, manifest) {
  if (parseReleaseTag(tag).product !== 'desktop') throw new Error('download table requires a Desktop tag');
  const assets = verifiedDownloadAssets(tag, manifest);
  const table = [
    '| 操作系统 / OS | 格式 / Package | 使用场景 / Use | 下载 / Download |',
    '| --- | --- | --- | --- |',
  ];
  for (const [index, item] of DESKTOP_PACKAGES.entries()) {
    const url = assets === undefined
      ? `${RELEASE_ROOT}/tag/${tag}#assets`
      : `${RELEASE_ROOT}/download/${tag}/${encodeURIComponent(assets[index].name.replace(/\s/g, '.'))}`;
    table.push(`| ${item.os} | ${item.format} | ${item.purpose} | [下载 / Download](${url}) |`);
  }
  table.push('| macOS | — | 尚未提供正式安装包 / Not released yet | — |');
  return table.join('\n');
}

function releaseNotesFromChangelog(changelog, tag, manifest) {
  const { product, version } = parseReleaseTag(tag);
  const section = changelogSection(changelog, version);
  if (product === 'cli') {
    if (manifest !== undefined) throw new Error('CLI notes do not accept a Desktop manifest');
    return `## CLI / TUI v${version} — 更新说明 / Release highlights\n\n${section}\n\n---\n\n## 安装与启动 / Install and run\n\n需要 Node.js 24 或更新版本。CLI 与 TUI 使用同一个 npm 包；在交互式终端运行 \`ligule\`，单轮命令使用 \`ligule run "任务内容"\`。\n\nRequires Node.js 24 or newer. The same npm package includes CLI and TUI: run \`ligule\` in an interactive terminal, or use \`ligule run "task"\` for a one-shot command.\n\n\`npm install -g ligule@${version}\`\n\n[在 npm 查看此版本 / View this version on npm](https://www.npmjs.com/package/ligule/v/${version})\n\nCLI/TUI 通过 npm 分发；此 GitHub Release 仅提供双语更新说明，不附带安装包。\n\nCLI/TUI is distributed through npm; this GitHub Release contains bilingual notes, not installable artifacts.\n`;
  }
  return `## Desktop v${version} — 更新说明 / Release highlights\n\n${section}\n\n---\n\n## 下载 / Downloads\n\n按操作系统选择对应的安装包。Linux AppImage 适合直接运行；deb 适合 Debian/Ubuntu 系发行版安装。桌面包包含自己的 Node Host，无需额外安装 Node.js。\n\nChoose the installer for your OS. AppImage is the portable Linux option; deb is for Debian/Ubuntu-based distributions. Desktop bundles its Node Host and does not require a separate Node.js installation.\n\n${desktopDownloadTable(tag, manifest)}\n\n### 校验 / Verify downloads\n\n- [SHA256SUMS](${RELEASE_ROOT}/download/${tag}/SHA256SUMS) — 安装包 SHA-256 校验值 / Installer SHA-256 checksums\n- [desktop-release-manifest.json](${RELEASE_ROOT}/download/${tag}/desktop-release-manifest.json) — 版本、来源提交和资产清单 / Version, source commit and asset manifest\n\nmacOS 不在本版正式发行范围内；以上文件只适用于对应的 x64 平台。\n\nmacOS is not included in this release. The downloads above are for the stated x64 targets only.\n`;
}

export function releaseNotesForTag(repositoryRoot, tag, { manifest } = {}) {
  const { product } = parseReleaseTag(tag);
  const changelogPath = product === 'cli' ? 'tui/CHANGELOG.md' : 'desktop/CHANGELOG.md';
  return releaseNotesFromChangelog(readFileSync(join(repositoryRoot, changelogPath), 'utf8'), tag, manifest);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, flag, manifestPath] = process.argv.slice(2);
  if (tag === undefined || (flag !== undefined && (flag !== '--manifest' || manifestPath === undefined))
    || process.argv.length > (flag === undefined ? 3 : 5)) {
    throw new Error('usage: node scripts/release-notes.js <cli-vX.Y.Z|desktop-vX.Y.Z> [--manifest FILE]');
  }
  const manifest = manifestPath === undefined ? undefined : JSON.parse(readFileSync(resolve(manifestPath), 'utf8'));
  process.stdout.write(releaseNotesForTag(root, tag, { manifest }));
}
