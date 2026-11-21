import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const lint = fileURLToPath(new URL('../skills/mydocs/scripts/lint-docs.mjs', import.meta.url));

// 首页检测只在仓库根生效，所以夹具里放一个空的 .git。
function run(files, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'mydocs-lint-'));
  mkdirSync(join(dir, '.git'), { recursive: true });
  const paths = [];
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    paths.push(path);
  }
  const result = spawnSync(process.execPath, [lint, ...args, ...paths], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const heading = (title) => `## ${title}\n\n一句话。`;

test('an internal topic in a README heading is reported but not fatal', () => {
  const { status, output } = run({ 'README.md': heading('架构') });
  assert.match(output, /readme-headings/);
  assert.equal(status, 0);
});

test('reader-facing headings stay quiet', () => {
  const { status, output } = run({
    'README.md': ['这是什么', '安装', '快速开始', '用法', '已知限制', '许可'].map(heading).join('\n\n') + '\n',
  });
  assert.doesNotMatch(output, /readme-headings/);
  assert.match(output, /没发现问题/);
  assert.equal(status, 0);
});

test('more second-level headings than the cap is reported', () => {
  const body = Array.from({ length: 9 }, (_, index) => heading(`小节 ${index + 1}`)).join('\n\n') + '\n';
  const { output } = run({ 'README.md': body });
  assert.match(output, /9 个二级标题，上限 8/);
});

test('headings inside a code fence are not counted', () => {
  const { output } = run({
    'README.md': `${heading('用法')}\n\n\`\`\`md\n## 架构\n## 模块\n## 数据流\n\`\`\`\n`,
  });
  assert.doesNotMatch(output, /readme-headings/);
});

test('a README under docs/ is not held to front-page rules', () => {
  const { output } = run({ 'docs/README.md': heading('架构') });
  assert.doesNotMatch(output, /readme-headings/);
});

test('mismatched zh/en skeletons are reported once', () => {
  const { status, output } = run({
    'README.md': '## 用法\n\n- 第一条\n- 第二条\n\n一段说明。\n',
    'README.en.md': '## Usage\n\n- first\n',
  });
  assert.match(output, /zh-en-parity/);
  assert.match(output, /二级标题 1 \/ 1|条目 2 \/ 1/);
  assert.equal(output.split('\n').filter((line) => line.includes('zh-en-parity')).length, 1);
  assert.equal(status, 0);
});

test('matching skeletons are not reported', () => {
  const { output } = run({
    'README.md': '## 用法\n\n- 第一条\n- 第二条\n',
    'README.en.md': '## Usage\n\n- first\n- second\n',
  });
  assert.doesNotMatch(output, /zh-en-parity/);
});

test('a lone README without a pair is not a mismatch', () => {
  const { output } = run({ 'README.md': heading('用法') });
  assert.doesNotMatch(output, /zh-en-parity/);
});

test('--strict turns a parity warning into a failure', () => {
  const files = {
    'README.md': '## 用法\n\n- 第一条\n- 第二条\n',
    'README.en.md': '## Usage\n\n- first\n',
  };
  assert.equal(run(files).status, 0);
  assert.equal(run(files, ['--strict']).status, 1);
});

test('a quoted bad example can switch a rule off for one line', () => {
  const { output } = run({
    'README.md': '## 用法\n<!-- lint-ignore-next-line readme-headings -->\n## 架构\n## 架构\n',
  });
  const hits = output.split('\n').filter((line) => line.includes('readme-headings'));
  assert.equal(hits.length, 1);
  assert.match(hits[0], /^\s+4\s/);
});

test('wording is not this linter business', () => {
  const { output } = run({
    'README.md': `## 用法\n\n开箱即用的多源播放；强大的扩展能力；灵活的配置。\n`,
  });
  assert.doesNotMatch(output, /banned-phrases|semicolon-density|sentence-length/);
});

test('a centred HTML header and its badges are not counted as paragraphs', () => {
  const header = [
    '<div align="center">',
    '  <img src="web/icon.svg" alt="A" width="88" height="88">',
    '  <h1>A</h1>',
    '  <p>',
    '    <a href="README.en.md">English</a> ·',
    '    <a href="LICENSE">MIT</a> ·',
    '  </p>',
    '</div>',
    '',
  ].join('\n');
  const { output } = run({
    'README.md': `${header}## 用法\n\n一段说明。\n`,
    'README.en.md': [
      '<div align="center">',
      '  <h1>A</h1>',
      '  <p><a href="README.md">Chinese</a></p>',
      '  <p><a href="LICENSE">MIT</a></p>',
      '</div>',
      '',
      '## Usage',
      '',
      'One line.',
      '',
    ].join('\n'),
  });
  assert.doesNotMatch(output, /zh-en-parity/);
});
