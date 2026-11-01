import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PRODUCTS = {
  cli: { manifest: 'tui/package.json', changelog: 'tui/CHANGELOG.md', source: 'tui/src/version.ts', tagPrefix: 'cli-v' },
  desktop: { manifest: 'desktop/package.json', changelog: 'desktop/CHANGELOG.md', tagPrefix: 'desktop-v' },
};

function productFiles(product) {
  if (!Object.hasOwn(PRODUCTS, product)) throw new Error(`product must be cli or desktop: ${product}`);
  return PRODUCTS[product];
}

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
  if (compareVersions(nextVersion, currentVersion) <= 0) {
    throw new Error(`release version ${nextVersion} must be newer than current version ${currentVersion}`);
  }
  return nextVersion;
}

export function requestedVersionAtRoot(repositoryRoot, product, requestedVersion) {
  const { manifest } = productFiles(product);
  const currentVersion = JSON.parse(readFileSync(join(repositoryRoot, manifest), 'utf8')).version;
  return resolveVersion(currentVersion, requestedVersion);
}

function skipJsonString(source, start) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') index += 1;
    else if (source[index] === '"') return index + 1;
  }
  throw new Error('invalid JSON string');
}

function skipJsonValue(source, start) {
  if (source[start] === '"') return skipJsonString(source, start);
  if (source[start] === '{' || source[start] === '[') {
    const closing = [source[start] === '{' ? '}' : ']'];
    for (let index = start + 1; index < source.length; index += 1) {
      const character = source[index];
      if (character === '"') index = skipJsonString(source, index) - 1;
      else if (character === '{' || character === '[') closing.push(character === '{' ? '}' : ']');
      else if (character === closing.at(-1)) {
        closing.pop();
        if (closing.length === 0) return index + 1;
      }
    }
    throw new Error('invalid JSON container');
  }
  let index = start;
  while (index < source.length && !/[\s,}\]]/.test(source[index])) index += 1;
  return index;
}

function topLevelVersionValue(source) {
  const whitespace = (index) => {
    while (/\s/.test(source[index] ?? '')) index += 1;
    return index;
  };
  let index = whitespace(0);
  if (source[index] !== '{') throw new Error('JSON manifest must be an object');
  index += 1;
  while ((index = whitespace(index)) < source.length && source[index] !== '}') {
    const keyStart = index;
    if (source[index] !== '"') throw new Error('invalid JSON object key');
    index = skipJsonString(source, index);
    const key = JSON.parse(source.slice(keyStart, index));
    index = whitespace(index);
    if (source[index] !== ':') throw new Error('invalid JSON object separator');
    const valueStart = whitespace(index + 1);
    const valueEnd = skipJsonValue(source, valueStart);
    if (key === 'version') return { start: valueStart, end: valueEnd };
    index = whitespace(valueEnd);
    if (source[index] === ',') index += 1;
    else if (source[index] !== '}') throw new Error('invalid JSON object ending');
  }
  return null;
}

function updateJsonFile(path, expectedVersion, nextVersion) {
  const source = readFileSync(path, 'utf8');
  const document = JSON.parse(source);
  if (document.version !== expectedVersion) {
    throw new Error(`${path} version is ${document.version}, expected ${expectedVersion}`);
  }
  const value = topLevelVersionValue(source);
  if (value === null || JSON.parse(source.slice(value.start, value.end)) !== expectedVersion) {
    throw new Error(`${path} top-level version entry is missing or does not match ${expectedVersion}`);
  }
  return `${source.slice(0, value.start)}${JSON.stringify(nextVersion)}${source.slice(value.end)}`;
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

export function changelogWithRelease(changelog, version, date = new Date().toISOString().slice(0, 10)) {
  const lines = changelog.split(/\r?\n/);
  const releaseHeading = `## [${version}]`;
  if (lines.some((line) => line === releaseHeading || line.startsWith(`${releaseHeading} `))) {
    throw new Error(`changelog already has a ${version} entry`);
  }
  const unreleased = lines.flatMap((line, index) => line === '## [Unreleased]' ? [index] : []);
  if (unreleased.length !== 1) throw new Error('changelog must have exactly one [Unreleased] section');
  const index = unreleased[0];
  const end = lines.findIndex((line, lineIndex) => lineIndex > index && line.startsWith('## '));
  const section = lines.slice(index + 1, end < 0 ? lines.length : end).join('\n').trim();
  const sectionLines = section.split('\n');
  for (const language of ['### 简体中文', '### English']) {
    const position = sectionLines.indexOf(language);
    const nextHeading = sectionLines.findIndex((line, lineIndex) => lineIndex > position && line.startsWith('### '));
    if (position < 0 || sectionLines.slice(position + 1, nextHeading < 0 ? sectionLines.length : nextHeading)
      .every((line) => line.trim().length === 0)) {
      throw new Error(`changelog [Unreleased] section needs content under ${language}`);
    }
  }
  lines.splice(index, 1, '## [Unreleased]', '', `${releaseHeading} - ${date}`);
  return `${lines.join('\n').replace(/\n*$/, '\n')}`;
}

export function versionFileUpdates(repositoryRoot, product, requestedVersion) {
  const files = productFiles(product);
  const packagePath = join(repositoryRoot, files.manifest);
  const currentVersion = JSON.parse(readFileSync(packagePath, 'utf8')).version;
  parseVersion(currentVersion);
  const version = resolveVersion(currentVersion, requestedVersion);
  const updates = new Map([[packagePath, updateJsonFile(packagePath, currentVersion, version)]]);
  if (files.source) {
    const sourcePath = join(repositoryRoot, files.source);
    updates.set(sourcePath, updateSourceVersion(sourcePath, currentVersion, version));
  }
  const changelogPath = join(repositoryRoot, files.changelog);
  updates.set(changelogPath, changelogWithRelease(readFileSync(changelogPath, 'utf8'), version));
  return { version, updates };
}

export function prepareRelease(repositoryRoot, product, requestedVersion) {
  const { version, updates } = versionFileUpdates(repositoryRoot, product, requestedVersion);
  for (const [path, contents] of updates) writeFileSync(path, contents, 'utf8');
  return { version, product, tag: `${productFiles(product).tagPrefix}${version}`, files: [...updates.keys()].map((path) => relative(repositoryRoot, path)).sort() };
}

const [command, product, request] = process.argv.slice(2);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!['resolve', 'prepare'].includes(command) || request === undefined || process.argv.length > 5) {
    throw new Error('usage: node scripts/release-version.js <resolve|prepare> <cli|desktop> <patch|minor|major|X.Y.Z>');
  }
  if (command === 'resolve') {
    process.stdout.write(`${requestedVersionAtRoot(root, product, request)}\n`);
  } else {
    const result = prepareRelease(root, product, request);
    process.stdout.write(`${result.version}\n${result.tag}\n${result.files.join('\n')}\n`);
  }
}
