import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(version) {
  const match = STABLE_VERSION.exec(version);
  if (match === null) throw new Error(`version must use stable X.Y.Z form: ${version}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return Math.sign(leftParts[index] - rightParts[index]);
  }
  return 0;
}

export function resolveVersion(currentVersion, requestedVersion) {
  const [major, minor, patch] = parseVersion(currentVersion);
  let nextVersion;
  if (requestedVersion === 'major') nextVersion = `${major + 1}.0.0`;
  else if (requestedVersion === 'minor') nextVersion = `${major}.${minor + 1}.0`;
  else if (requestedVersion === 'patch') nextVersion = `${major}.${minor}.${patch + 1}`;
  else {
    parseVersion(requestedVersion);
    nextVersion = requestedVersion;
  }
  if (compareVersions(nextVersion, currentVersion) < 0) {
    throw new Error(`release version ${nextVersion} is older than current version ${currentVersion}`);
  }
  return nextVersion;
}

export function requestedVersionAtRoot(repositoryRoot, requestedVersion) {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
  return resolveVersion(manifest.version, requestedVersion);
}

function updateJsonFile(path, expectedVersion, nextVersion) {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  if (document.version !== expectedVersion) {
    throw new Error(`${path} version is ${document.version}, expected ${expectedVersion}`);
  }
  document.version = nextVersion;
  return `${JSON.stringify(document, null, 2)}\n`;
}

function updateSourceVersion(path, expectedVersion, nextVersion) {
  const source = readFileSync(path, 'utf8');
  const pattern = /^export const VERSION = '([^']+)';$/m;
  const match = pattern.exec(source);
  if (match === null || match[1] !== expectedVersion) {
    throw new Error(`${path} VERSION is ${match?.[1] ?? 'missing'}, expected ${expectedVersion}`);
  }
  return `${source.slice(0, match.index)}export const VERSION = '${nextVersion}';${source.slice(match.index + match[0].length)}`;
}

function updateReleaseDocVersion(path, expectedVersion, nextVersion) {
  const source = readFileSync(path, 'utf8');
  const pattern = new RegExp(`^(\\| \x60ligule\x60 \\|[^\\r\\n]*\\| )\x60${expectedVersion}\x60( \\|)$`, 'm');
  if (!pattern.test(source)) throw new Error(`${path} must list ligule@${expectedVersion} in its package table`);
  return source.replace(pattern, `$1\x60${nextVersion}\x60$2`);
}

function changelogWithRelease(changelog, version, date = new Date().toISOString().slice(0, 10)) {
  const lines = changelog.split(/\r?\n/);
  const releaseHeading = `## [${version}]`;
  if (lines.some((line) => line === releaseHeading || line.startsWith(`${releaseHeading} `))) {
    throw new Error(`CHANGELOG.md already has a ${version} entry`);
  }
  const unreleased = lines.flatMap((line, index) => line === '## [Unreleased]' ? [index] : []);
  if (unreleased.length !== 1) throw new Error(`CHANGELOG.md must have exactly one [Unreleased] section`);
  const index = unreleased[0];
  const end = lines.findIndex((line, lineIndex) => lineIndex > index && line.startsWith('## '));
  const section = lines.slice(index + 1, end < 0 ? lines.length : end).join('\n').trim();
  const sectionLines = section.split('\n');
  for (const language of ['### 简体中文', '### English']) {
    const position = sectionLines.indexOf(language);
    const nextHeading = sectionLines.findIndex((line, lineIndex) => lineIndex > position && line.startsWith('### '));
    if (position < 0 || sectionLines.slice(position + 1, nextHeading < 0 ? sectionLines.length : nextHeading)
      .every((line) => line.trim().length === 0)) {
      throw new Error(`CHANGELOG.md [Unreleased] section needs content under ${language}`);
    }
  }
  lines.splice(index, 1, '## [Unreleased]', '', '### 简体中文', '', '### English', '', `${releaseHeading} - ${date}`);
  return `${lines.join('\n').replace(/\n*$/, '\n')}`;
}

export function versionFileUpdates(repositoryRoot, requestedVersion) {
  const packagePath = join(repositoryRoot, 'package.json');
  const currentVersion = JSON.parse(readFileSync(packagePath, 'utf8')).version;
  parseVersion(currentVersion);
  const version = resolveVersion(currentVersion, requestedVersion);
  const updates = new Map();
  const addJson = (relativePath) => {
    const path = join(repositoryRoot, relativePath);
    updates.set(path, updateJsonFile(path, currentVersion, version));
  };

  addJson('package.json');
  addJson('desktop/package.json');
  addJson('desktop/frontend/package.json');

  const sourcePath = join(repositoryRoot, 'src', 'version.ts');
  updates.set(sourcePath, updateSourceVersion(sourcePath, currentVersion, version));

  for (const path of ['docs/development/RELEASE.zh-cn.md', 'docs/development/RELEASE.en.md']) {
    const absolutePath = join(repositoryRoot, path);
    updates.set(absolutePath, updateReleaseDocVersion(absolutePath, currentVersion, version));
  }

  const changelogPath = join(repositoryRoot, 'CHANGELOG.md');
  updates.set(changelogPath, changelogWithRelease(readFileSync(changelogPath, 'utf8'), version));
  return { version, updates };
}

export function prepareRelease(repositoryRoot, requestedVersion) {
  const { version, updates } = versionFileUpdates(repositoryRoot, requestedVersion);
  for (const [path, contents] of updates) writeFileSync(path, contents, 'utf8');
  return { version, files: [...updates.keys()].map((path) => path.slice(repositoryRoot.length + 1)).sort() };
}

const [command, request] = process.argv.slice(2);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (command !== 'prepare' || request === undefined || process.argv.length > 4) {
    if (command === 'resolve' && request !== undefined && process.argv.length === 4) {
      process.stdout.write(`${requestedVersionAtRoot(root, request)}\n`);
    } else {
      throw new Error('usage: node scripts/release-version.js <resolve|prepare> <patch|minor|major|X.Y.Z>');
    }
  } else {
    const result = prepareRelease(root, request);
    process.stdout.write(`${result.version}\n`);
    process.stdout.write(`${result.files.join('\n')}\n`);
  }
}
