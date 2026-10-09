// 仓库 markdown 的检查：链接与锚点在自己能读到的范围内可达，两份手册节数相等并覆盖同一批标识符，
// README 有语言入口，`docs/` 只有那两份，每份工程指南都能整份读进默认的读入上限并跟着根那一份装载。
// 这一处不建内核：读的是仓库里的 markdown。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, sep } from 'node:path';
import { DEFAULT_LIMITS } from '../dist/capability/limits.js';
import { loadInstructions } from '../dist/index.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const zhPath = join(repoRoot, 'docs', 'guide.zh-CN.md');
const enPath = join(repoRoot, 'docs', 'guide.en.md');
// 工程指南三份：根那一份放全局规则，两份局部的放在各自代码旁边。
const guides = ['AGENTS.md', join('desktop', 'AGENTS.md'), join('src', 'tui', 'AGENTS.md')];
const guidePath = (guide) => join(repoRoot, guide);

/** 标题换成 GitHub 那一种锚点：小写、去掉除字母数字与连字符以外的字符、空格换成连字符。 */
function slug(heading) {
  return heading.trim().toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\- ]/gu, '')
    .replace(/ /g, '-');
}

function anchors(text) {
  return new Set(text.split('\n').filter((line) => /^#{1,6}\s/.test(line)).map((line) => slug(line.replace(/^#+\s/, ''))));
}

/** markdown 里所有链接目标，带锚点的那一段留着。 */
function links(text) {
  return [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]);
}

function codeTokens(text) {
  return new Set([...text.matchAll(/`([^`]+)`/g)].map((match) => match[1])
    .filter((token) => /^[a-z][a-z0-9_.-]{2,}$/.test(token) && /[._]/.test(token)));
}

test('手册的相对链接与锚点都落在仓库内', () => {
  for (const file of [zhPath, enPath, join(repoRoot, 'README.md'), ...guides.map(guidePath)]) {
    const base = dirname(file);
    for (const target of links(readFileSync(file, 'utf8'))) {
      if (/^https?:/.test(target)) continue;
      const [pathPart, hash] = target.split('#');
      const resolved = pathPart === '' ? file : join(base, posix.normalize(pathPart));
      assert.ok(existsSync(resolved), `${file} 里的 ${target} 指向读不到的文件`);
      if (hash !== undefined && pathPart !== '') {
        assert.ok(anchors(readFileSync(resolved, 'utf8')).has(hash), `${file} 里的 ${target} 指到没有的锚点`);
      }
      if (hash !== undefined && pathPart === '') {
        assert.ok(anchors(readFileSync(file, 'utf8')).has(hash), `${file} 里的 ${target} 指到本文没有的锚点`);
      }
    }
  }
});

test('两份手册的章节数与目录一一对应', () => {
  const headings = (text) => text.split('\n').filter((line) => /^##\s/.test(line)).length;
  assert.equal(headings(readFileSync(zhPath, 'utf8')), headings(readFileSync(enPath, 'utf8')));
});

test('两种语言覆盖同一批命令、稳定码与配置键', () => {
  const zh = codeTokens(readFileSync(zhPath, 'utf8'));
  const en = codeTokens(readFileSync(enPath, 'utf8'));
  const onlyZh = [...zh].filter((token) => !en.has(token));
  const onlyEn = [...en].filter((token) => !zh.has(token));
  assert.deepEqual({ onlyZh, onlyEn }, { onlyZh: [], onlyEn: [] });
});

test('README 有指向两种语言的入口', () => {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /docs\/guide\.zh-CN\.md/);
  assert.match(readme, /docs\/guide\.en\.md/);
});

test('docs 目录只有这两种语言的入口，且都有正文', () => {
  const files = readdirSync(join(repoRoot, 'docs')).sort();
  assert.deepEqual(files, ['guide.en.md', 'guide.zh-CN.md']);
  for (const name of files) {
    assert.ok(readFileSync(join(repoRoot, 'docs', name), 'utf8').startsWith('# '), `${name} 的第一行不是一级标题`);
  }
});

// 工程指南分三份放之后要守的两条：每份都能整份读进默认上限，局部那两份真的能被装载到。
// 装载那一条按这一份仓库自己的目录跑，不建临时夹具：夹具验的是机制，这里验的是这份布局。
test('每份工程指南都在默认读入上限之内，且局部那两份跟着根那一份装载', async () => {
  for (const guide of guides) {
    const bytes = Buffer.byteLength(readFileSync(guidePath(guide), 'utf8'), 'utf8');
    assert.ok(bytes < DEFAULT_LIMITS.readBytes, `${guide} 有 ${bytes} 字节，超过默认读入的 ${DEFAULT_LIMITS.readBytes} 字节`);
  }
  const rootGuide = readFileSync(guidePath(guides[0]), 'utf8');
  for (const guide of guides.slice(1)) {
    assert.ok(rootGuide.includes(guide.split(sep).join('/')), `AGENTS.md 没有指向 ${guide}`);
  }
  for (const directory of [join(repoRoot, 'desktop'), join(repoRoot, 'src', 'tui')]) {
    const loaded = await loadInstructions({ boundary: repoRoot, current: directory, maxBytes: 200_000 });
    assert.deepEqual(loaded.files.map((file) => file.layer), ['project', 'directory'], `${directory} 那一份没有连根那一份一起装上`);
  }
});
