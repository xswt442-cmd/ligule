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

function releaseNotesFromChangelog(changelog, tag) {
  const { product, version } = parseReleaseTag(tag);
  const section = changelogSection(changelog, version);
  if (product === 'cli') return section;
  return `${section}\n\n---\n\n## 下载 / Downloads\n\n桌面安装包与 SHA-256 校验值会在完成平台验收后加入此草稿 Release。\n\nDesktop installers and SHA-256 checksums are added to this draft Release after platform validation.\n`;
}

export function releaseNotesForTag(repositoryRoot, tag) {
  const { product } = parseReleaseTag(tag);
  const changelogPath = product === 'cli' ? 'CHANGELOG.md' : 'desktop/CHANGELOG.md';
  return releaseNotesFromChangelog(readFileSync(join(repositoryRoot, changelogPath), 'utf8'), tag);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag] = process.argv.slice(2);
  if (tag === undefined || process.argv.length > 3) {
    throw new Error('usage: node scripts/release-notes.js <cli-vX.Y.Z|desktop-vX.Y.Z>');
  }
  process.stdout.write(releaseNotesForTag(root, tag));
}
