// 仓库文档的检查：受维护的 Markdown 链接可达，两份手册章节与标识符一致，
// README 有使用与开发文档入口，八份指南都在默认预算内并按目录装载。
// 这一处不建内核：读的是仓库里的 markdown。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { parse } from '../core/node_modules/smol-toml/dist/index.js';
import { DEFAULT_LIMITS } from '../core/dist/capability/limits.js';
import { loadInstructions } from '../core/dist/index.js';
import { modelServices, resolveModel } from '../core/dist/kernel/model-services.js';
import { releaseNotesForTag } from '../scripts/release-notes.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const zhPath = join(repoRoot, 'docs', 'guide.zh-CN.md');
const enPath = join(repoRoot, 'docs', 'guide.en.md');
const bilingualPairs = [
  [join(repoRoot, 'README.md'), join(repoRoot, 'README.en.md')],
  [join(repoRoot, 'tui', 'README.md'), join(repoRoot, 'tui', 'README.en.md')],
  [join(repoRoot, 'desktop', 'README.md'), join(repoRoot, 'desktop', 'README.en.md')],
  [zhPath, enPath],
  [join(repoRoot, 'docs', 'development', 'ARCHITECTURE.zh-cn.md'), join(repoRoot, 'docs', 'development', 'ARCHITECTURE.en.md')],
  [join(repoRoot, 'docs', 'development', 'GLOSSARY.zh-cn.md'), join(repoRoot, 'docs', 'development', 'GLOSSARY.en.md')],
  [join(repoRoot, 'docs', 'development', 'CONTRIBUTING.zh-cn.md'), join(repoRoot, 'docs', 'development', 'CONTRIBUTING.en.md')],
];
const maintainedDocs = [
  ...bilingualPairs.flatMap((pair) => pair),
  join(repoRoot, 'tui', 'CHANGELOG.md'),
  join(repoRoot, 'docs', 'development', 'RELEASE.md'),
  join(repoRoot, 'tui', 'docs', 'guide.zh-CN.md'),
  join(repoRoot, 'tui', 'docs', 'guide.en.md'),
];
// 工程指南八份：根那一份放全局规则，七份局部规则放在模块和 Desktop 子目录内。
const guides = [
  'AGENTS.md',
  join('desktop', 'AGENTS.md'),
  join('desktop', 'frontend', 'AGENTS.md'),
  join('core', 'src', 'kernel', 'AGENTS.md'),
  join('core', 'src', 'tools', 'AGENTS.md'),
  join('core', 'src', 'session', 'AGENTS.md'),
  join('core', 'src', 'host', 'AGENTS.md'),
  join('tui', 'AGENTS.md'),
];
const localGuides = [
  join(repoRoot, 'desktop'),
  join(repoRoot, 'desktop', 'frontend'),
  join(repoRoot, 'core', 'src', 'kernel'),
  join(repoRoot, 'core', 'src', 'tools'),
  join(repoRoot, 'core', 'src', 'session'),
  join(repoRoot, 'core', 'src', 'host'),
  join(repoRoot, 'tui'),
];
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

function tomlExample(text) {
  const match = text.match(/```toml\n([\s\S]*?)\n```/);
  assert.ok(match, 'guide must contain a TOML example');
  return parse(match[1]);
}

test('所有受维护文档的相对链接与锚点都落在仓库内', () => {
  for (const file of [...maintainedDocs, ...guides.map(guidePath)]) {
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

test('所有中英文配对文档的章节数对应', () => {
  const headings = (text) => text.split('\n').filter((line) => /^##\s/.test(line)).length;
  for (const [zh, en] of bilingualPairs) {
    assert.equal(headings(readFileSync(zh, 'utf8')), headings(readFileSync(en, 'utf8')), `${zh} 与 ${en} 的章节数不同`);
  }
});

test('所有中英文配对文档包含相同的代码标识符', () => {
  for (const [zh, en] of bilingualPairs) {
    const zhTokens = codeTokens(readFileSync(zh, 'utf8'));
    const enTokens = codeTokens(readFileSync(en, 'utf8'));
    const onlyZh = [...zhTokens].filter((token) => !enTokens.has(token));
    const onlyEn = [...enTokens].filter((token) => !zhTokens.has(token));
    assert.deepEqual({ onlyZh, onlyEn }, { onlyZh: [], onlyEn: [] }, `${zh} 与 ${en} 的标识符不同`);
  }
});

test('双语手册的多服务 TOML 示例相同且符合实际配置格式', () => {
  const zh = tomlExample(readFileSync(zhPath, 'utf8'));
  const en = tomlExample(readFileSync(enPath, 'utf8'));
  assert.deepEqual(zh, en);
  assert.equal(modelServices(zh.model.services).length, 1);
  assert.deepEqual(resolveModel(zh.model), {
    api: 'chat-completions',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    services: zh.model.services,
    selection: zh.model.selection,
    serviceId: 'deepseek',
  });
});

test('workspace and TUI READMEs point to module and product documentation', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'tui', 'package.json'), 'utf8'));
  const rootReadme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  const readme = readFileSync(join(repoRoot, 'tui', 'README.md'), 'utf8');
  const englishReadme = readFileSync(join(repoRoot, 'tui', 'README.en.md'), 'utf8');
  assert.match(rootReadme, /core\/.*tui\/.*desktop\//s);
  assert.match(rootReadme, /docs\/development\/ARCHITECTURE\.zh-cn\.md/);
  assert.match(readme, /docs\/guide\.zh-CN\.md/);
  assert.match(readme, /github\.com\/xswt442-cmd\/ligule\/blob\/main\/docs\/development\/ARCHITECTURE\.zh-cn\.md/);
  assert.match(readme, /github\.com\/xswt442-cmd\/ligule\/blob\/main\/docs\/development\/RELEASE\.md/);
  assert.match(englishReadme, /github\.com\/xswt442-cmd\/ligule\/blob\/main\/docs\/development\/ARCHITECTURE\.en\.md/);
  assert.match(readme, /CHANGELOG\.md/);
  assert.match(englishReadme, /CHANGELOG\.md/);
  assert.ok(manifest.files.includes('README.en.md'), 'the English README must be included in the npm package');
  assert.ok(manifest.files.some((file) => file.includes('CHANGELOG.md')), 'the version history must be included in the npm package');
});

test('the CLI bilingual changelog section generates CLI release notes without Desktop assets', () => {
  const changelog = readFileSync(join(repoRoot, 'tui', 'CHANGELOG.md'), 'utf8');
  const notes = releaseNotesForTag(repoRoot, 'cli-v0.0.1');
  assert.match(changelog, /^## \[Unreleased\]/m);
  assert.match(notes, /初始公开版本/);
  assert.match(notes, /Initial public release/);
  assert.doesNotMatch(notes, /SHA-256|Downloads/);
  assert.match(notes, /运行 `ligule`/);
  assert.match(notes, /npm install -g ligule@0\.0\.1/);
  assert.doesNotMatch(notes, /desktop-release-manifest\.json|\.AppImage|\.deb/);
});

test('docs 根目录只放双语使用手册，且都有正文', () => {
  const files = readdirSync(join(repoRoot, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .sort();
  assert.deepEqual(files, ['guide.en.md', 'guide.zh-CN.md']);
  for (const name of files) {
    assert.ok(readFileSync(join(repoRoot, 'docs', name), 'utf8').startsWith('# '), `${name} 的第一行不是一级标题`);
  }
});

test('development 文档文件名使用大写主体与小写语言标记', () => {
  const files = readdirSync(join(repoRoot, 'docs', 'development'))
    .filter((name) => name.endsWith('.md'))
    .sort();
  assert.deepEqual(files, [
    'ARCHITECTURE.en.md',
    'ARCHITECTURE.zh-cn.md',
    'CONTRIBUTING.en.md',
    'CONTRIBUTING.zh-cn.md',
    'GLOSSARY.en.md',
    'GLOSSARY.zh-cn.md',
    'RELEASE.md',
  ]);
});

// 工程指南分几份放之后要守的两条：每份都能整份读进默认读入上限，且每一处都以默认预算完整装载。
// 装载那一条按这一份仓库自己的目录跑，不建临时夹具：夹具验的是机制，这里验的是这份布局。
// 预算那一格用的是默认值，并当场看有没有截断标记——「必要规则在默认总预算内完整装载」说的就是这一件事（审阅 C09）。
test('每份工程指南都在默认读入上限之内，且每一处都以默认预算完整装载', async () => {
  for (const guide of guides) {
    const bytes = Buffer.byteLength(readFileSync(guidePath(guide), 'utf8'), 'utf8');
    assert.ok(bytes < DEFAULT_LIMITS.readBytes, `${guide} 有 ${bytes} 字节，超过默认读入的 ${DEFAULT_LIMITS.readBytes} 字节`);
  }
  const rootGuide = readFileSync(guidePath(guides[0]), 'utf8');
  for (const guide of guides.slice(1)) {
    // 根那一份按目录指过去（每一处局部的都叫 `AGENTS.md`，写全名会把预算吃在同一个词上）。
    assert.ok(rootGuide.includes(posix.dirname(guide.split(sep).join('/')) + '/'), `AGENTS.md 没有指向 ${guide} 所在的那个目录`);
  }
  const atRoot = await loadInstructions({ boundary: repoRoot, current: repoRoot });
  assert.deepEqual(atRoot.files.map((file) => file.layer), ['project'], '只从项目根装载时只有根那一份');
  assert.ok(!atRoot.text.includes('[Instruction budget'), '默认预算下根那一份被截断了');
  for (const directory of localGuides) {
    const loaded = await loadInstructions({ boundary: repoRoot, current: directory });
    // 目录套目录时上溯会走到不止一份局部指南（`desktop/frontend/` 之外还有 `desktop/` 那一份），
    // 所以这里只要求第一层是项目根那一份、其余都是目录级，并且这一处自己的那一份在最后。
    assert.equal(loaded.files[0].layer, 'project', `${directory} 处没有先装载根那一份`);
    assert.ok(loaded.files.slice(1).every((file) => file.layer === 'directory'), `${directory} 处的目录级层标错了`);
    assert.equal(resolve(loaded.files[loaded.files.length - 1].path), resolve(directory, 'AGENTS.md'), `${directory} 那一份没有连根那一份一起装载`);
    assert.ok(!loaded.text.includes('[Instruction budget'), `${directory} 处按默认预算装载时被截断了`);
  }
});
