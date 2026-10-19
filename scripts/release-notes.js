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
  { target: 'windows-x64', extension: '.exe', os: 'Windows x64', format: 'NSIS (.exe)', purposeZh: '安装向导', purposeEn: 'Installer wizard' },
  { target: 'linux-x64', extension: '.AppImage', os: 'Linux x64', format: 'AppImage', purposeZh: '免安装运行', purposeEn: 'Portable app' },
  { target: 'linux-x64', extension: '.deb', os: 'Linux x64', format: 'deb (.deb)', purposeZh: 'Debian/Ubuntu 系发行版', purposeEn: 'Debian/Ubuntu-based distributions' },
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

export function desktopDownloadTable(tag, manifest, language = 'zh-CN') {
  if (parseReleaseTag(tag).product !== 'desktop') throw new Error('download table requires a Desktop tag');
  if (language !== 'zh-CN' && language !== 'en') throw new Error('download table language must be zh-CN or en');
  const assets = verifiedDownloadAssets(tag, manifest);
  const columns = language === 'zh-CN'
    ? ['操作系统', '格式', '用途', '下载']
    : ['OS', 'Package', 'Use', 'Download'];
  const table = [
    `| ${columns.join(' | ')} |`,
    '| --- | --- | --- | --- |',
  ];
  for (const [index, item] of DESKTOP_PACKAGES.entries()) {
    const url = assets === undefined
      ? `${RELEASE_ROOT}/tag/${tag}#assets`
      : `${RELEASE_ROOT}/download/${tag}/${encodeURIComponent(assets[index].name.replace(/\s/g, '.'))}`;
    const purpose = language === 'zh-CN' ? item.purposeZh : item.purposeEn;
    const download = language === 'zh-CN' ? '下载' : 'Download';
    table.push(`| ${item.os} | ${item.format} | ${purpose} | [${download}](${url}) |`);
  }
  return table.join('\n');
}

function splitChangelogLanguages(section) {
  const lines = section.split(/\r?\n/);
  const chineseSections = lines.flatMap((line, index) => line === '### 简体中文' ? [index] : []);
  const englishSections = lines.flatMap((line, index) => line === '### English' ? [index] : []);
  if (chineseSections.length !== 1 || englishSections.length !== 1 || chineseSections[0] >= englishSections[0]) {
    throw new Error('release notes require one Simplified Chinese section followed by one English section');
  }
  const chinese = lines.slice(chineseSections[0] + 1, englishSections[0]).join('\n').trim();
  const english = lines.slice(englishSections[0] + 1).join('\n').trim();
  if (!chinese || !english) throw new Error('release notes require content in both language sections');
  return { chinese, english };
}

function releaseNotesFromChangelog(changelog, tag, manifest) {
  const { product, version } = parseReleaseTag(tag);
  const { chinese, english } = splitChangelogLanguages(changelogSection(changelog, version));
  if (product === 'cli') {
    if (manifest !== undefined) throw new Error('CLI notes do not accept a Desktop manifest');
    return `## CLI / TUI v${version}\n\n### 简体中文\n\n${chinese}\n\n#### 安装与启动\n\n需要 Node.js 24 或更新版本。运行 \`npm install -g ligule@${version}\` 安装；在交互式终端运行 \`ligule\` 打开 TUI，或运行 \`ligule run "任务内容"\` 执行单轮任务。\n\n[在 npm 查看此版本](https://www.npmjs.com/package/ligule/v/${version})\n\n### English\n\n${english}\n\n#### Install and run\n\nRequires Node.js 24 or newer. Install with \`npm install -g ligule@${version}\`. Run \`ligule\` in an interactive terminal to open the TUI, or run \`ligule run "task"\` for a one-shot request.\n\n[View this version on npm](https://www.npmjs.com/package/ligule/v/${version})\n`;
  }
  return `## Desktop v${version}\n\n### 简体中文\n\n${chinese}\n\n#### 下载\n\nLinux AppImage 适合直接运行；deb 适合 Debian/Ubuntu 系发行版安装。桌面包包含自己的 Node Host，无需额外安装 Node.js。\n\n${desktopDownloadTable(tag, manifest, 'zh-CN')}\n\n#### 校验下载\n\n- [SHA256SUMS](${RELEASE_ROOT}/download/${tag}/SHA256SUMS) — 安装包 SHA-256 校验值\n- [desktop-release-manifest.json](${RELEASE_ROOT}/download/${tag}/desktop-release-manifest.json) — 版本、来源提交和资产清单\n\n本版本未提供发布者数字签名；SHA-256 校验值用于检查文件完整性。\n\n### English\n\n${english}\n\n#### Downloads\n\nThe Linux AppImage runs as a portable app; the deb package is for Debian/Ubuntu-based distributions. The desktop package includes its Node Host and does not require a separate Node.js installation.\n\n${desktopDownloadTable(tag, manifest, 'en')}\n\n#### Verify downloads\n\n- [SHA256SUMS](${RELEASE_ROOT}/download/${tag}/SHA256SUMS) — SHA-256 checksums for the installers\n- [desktop-release-manifest.json](${RELEASE_ROOT}/download/${tag}/desktop-release-manifest.json) — Version, source commit, and asset manifest\n\nThis release does not include publisher signatures; SHA-256 checksums verify file integrity.\n`;
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
