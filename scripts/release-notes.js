import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = `## [${version}]`;
  const starts = lines.flatMap((line, index) => line === heading || line.startsWith(`${heading} - `) ? [index] : []);
  if (starts.length !== 1) throw new Error(`CHANGELOG.md must have exactly one ${version} section`);
  const start = starts[0];
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const content = lines.slice(start + 1, next < 0 ? lines.length : next).join('\n').trim();
  const sectionLines = content.split('\n');
  for (const language of ['### 简体中文', '### English']) {
    const position = sectionLines.indexOf(language);
    const nextHeading = sectionLines.findIndex((line, index) => index > position && line.startsWith('### '));
    if (position < 0 || sectionLines.slice(position + 1, nextHeading < 0 ? sectionLines.length : nextHeading)
      .every((line) => line.trim().length === 0)) {
      throw new Error(`CHANGELOG.md ${version} section needs content under ${language}`);
    }
  }
  return content;
}

export function releaseNotesForTag(changelog, tag) {
  const match = RELEASE_TAG.exec(tag);
  if (match === null) throw new Error(`release tag must use vX.Y.Z form: ${tag}`);
  const section = changelogSection(changelog, `${match[1]}.${match[2]}.${match[3]}`);
  return `${section}\n\n---\n\n## 下载 / Downloads\n\n桌面安装包与 SHA-256 校验值会在完成平台验收后加入本 Release。\n\nDesktop installers and SHA-256 checksums are added to this Release after platform validation.\n`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag] = process.argv.slice(2);
  if (tag === undefined || process.argv.length > 3) throw new Error('usage: node scripts/release-notes.js vX.Y.Z');
  process.stdout.write(releaseNotesForTag(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), tag));
}
