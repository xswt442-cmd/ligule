import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryTemplate = fileURLToPath(new URL('../../PULL_REQUEST_TEMPLATE.md', import.meta.url));

test('GitHub PR template matches the canonical engineering template', () => {
  const canonical = readFileSync(new URL('../skills/mypr/repo/.github/PULL_REQUEST_TEMPLATE.md', import.meta.url));
  const applied = readFileSync(repositoryTemplate);
  assert.deepEqual(applied, canonical);
});

// 只有权威源自己的副本必须与模板逐字相同；产品仓按自身事实改写这两份文件，
// 标记文件 .canonical-source 不会随同步复制到产品仓。
const isCanonicalSource = existsSync(new URL('../.canonical-source', import.meta.url));

test('GitHub community health files match the canonical engineering templates', { skip: !isCanonicalSource }, () => {
  for (const name of ['SECURITY.md', 'CONTRIBUTING.md']) {
    const canonical = readFileSync(new URL('../templates/' + name, import.meta.url));
    const applied = readFileSync(new URL('../../' + name, import.meta.url));
    assert.deepEqual(applied, canonical, name + ' must match its canonical template');
  }
});

test('community health templates name a real contact route and link to each other', () => {
  const security = readFileSync(new URL('../templates/SECURITY.md', import.meta.url), 'utf8');
  const contributing = readFileSync(new URL('../templates/CONTRIBUTING.md', import.meta.url), 'utf8');
  assert.match(security, /asks for a preferred security contact/);
  assert.doesNotMatch(security, /private vulnerability reporting|direct message/i);
  assert.match(contributing, /\[SECURITY\.md\]\(SECURITY\.md\)/);
});

test('the standard documents where community health files belong', () => {
  const standard = readFileSync(new URL('../ENGINEERING_STANDARD.md', import.meta.url), 'utf8');
  assert.match(standard, /GitHub 社区健康文件/);
  assert.match(standard, /\.github\/SECURITY\.md/);
  assert.match(standard, /\.github\/CONTRIBUTING\.md/);
  assert.match(standard, /sync-community\.mjs/);
});

test('engineering guideline, PR template, and skill are consistent', () => {
  const standard = readFileSync(new URL('../ENGINEERING_STANDARD.md', import.meta.url), 'utf8');
  const skill = readFileSync(new URL('../skills/mypr/SKILL.md', import.meta.url), 'utf8');
  const template = readFileSync(new URL('../skills/mypr/repo/.github/PULL_REQUEST_TEMPLATE.md', import.meta.url), 'utf8');
  assert.match(standard, /\.github\/PULL_REQUEST_TEMPLATE\.md/);
  assert.match(skill, /The repository template owns/);
  assert.match(skill, /No diagram by default/);
  assert.match(template, /### 变更[\s\S]*### 任务[\s\S]*### 验证[\s\S]*## English/);
  assert.match(template, /### Changes[\s\S]*### Tasks[\s\S]*### Verification/);
  assert.match(standard, /SHA-256 是完整性校验/);
  assert.match(standard, /Conventional Commit/);
});

test('CHANGELOG template requires meaningful bilingual change categories without empty placeholders', () => {
  const standard = readFileSync(new URL('../ENGINEERING_STANDARD.md', import.meta.url), 'utf8');
  const template = readFileSync(new URL('../templates/CHANGELOG.md', import.meta.url), 'utf8');
  for (const label of ['**新增**', '**改进**', '**修复**', '**Added**', '**Improved**', '**Fixed**']) {
    assert.ok(template.includes(label), `CHANGELOG example missing ${label}`);
    assert.ok(standard.includes(label), `standard missing ${label}`);
  }
  assert.match(standard, /只出现有实际内容的类别/);
  assert.match(template, /## \[Unreleased\]/);
  assert.match(template, /### 简体中文[\s\S]*### English/);
});

const skillFiles = {
  mypr: ['SKILL.md', 'CREDITS.md', 'agents/openai.yaml'],
  mydocs: ['SKILL.md', 'agents/openai.yaml', 'rules.json', 'references/file-types.md', 'scripts/lint-docs.mjs'],
  myshuohua: [
    'SKILL.md', 'CREDITS.md', 'agents/openai.yaml', 'rules.json',
    'references/bad-good.md', 'references/language-zh.md', 'scripts/lint-shuohua.mjs',
  ],
};

// The installer copies only current source files and deliberately does not delete extras.
// Keep the canonical repository's tracked copies free of obsolete skill artifacts.
function filesUnder(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + entry.name;
    return entry.isDirectory()
      ? filesUnder(resolve(dir, entry.name), path + '/')
      : [path];
  }).sort();
}

test('canonical skill copies contain no files left over from old layouts', { skip: !isCanonicalSource }, () => {
  for (const name of Object.keys(skillFiles)) {
    const source = fileURLToPath(new URL(`../skills/${name}/`, import.meta.url));
    const installed = fileURLToPath(new URL(`../../../.agents/skills/${name}/`, import.meta.url));
    const expected = filesUnder(source).filter((file) => file !== 'scripts/install.mjs' && !file.startsWith('repo/'));
    assert.deepEqual(filesUnder(installed), expected, `${name}: installed file list must match the source manifest`);
  }
});

test('installed skills are byte-identical to the engineering sources', () => {
  for (const [name, files] of Object.entries(skillFiles)) {
    for (const file of files) {
      const canonical = readFileSync(new URL(`../skills/${name}/${file}`, import.meta.url));
      const installed = readFileSync(new URL(`../../../.agents/skills/${name}/${file}`, import.meta.url));
      assert.deepEqual(installed, canonical, `.agents/skills/${name}/${file} must match its source`);
    }
  }
});

test('each skill directory matches the name declared in its frontmatter', () => {
  for (const name of Object.keys(skillFiles)) {
    const body = readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(body, new RegExp(`^---\\nname: ${name}\\n`), `${name} must declare name: ${name}`);
  }
});

test('the install guide states where agents load skills from', () => {
  const guide = readFileSync(new URL('../skills/README.md', import.meta.url), 'utf8');
  assert.match(guide, /\.agents\/skills\//);
  assert.match(guide, /mypr[\s\S]*mydocs[\s\S]*myshuohua/);
  assert.match(guide, /逐字一致/);
  assert.match(guide, /软链/);
});

test('each skill ships the same installer and names its own install command', () => {
  const mypr = readFileSync(new URL('../skills/mypr/scripts/install.mjs', import.meta.url), 'utf8');
  for (const name of ['mydocs', 'myshuohua']) {
    const other = readFileSync(new URL(`../skills/${name}/scripts/install.mjs`, import.meta.url), 'utf8');
    assert.equal(other, mypr, `${name} must ship the same installer as mypr`);
  }
  for (const name of Object.keys(skillFiles)) {
    const body = readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(body, new RegExp(`skills/${name}/scripts/install\\.mjs --apply`), `${name} must document its installer`);
  }
});

test('this repository satisfies its own skill check', () => {
  const script = fileURLToPath(new URL('../scripts/skills.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--check', resolve(fileURLToPath(new URL('../../../', import.meta.url)))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('the standard requires tracked project skills with a my prefix', () => {
  const standard = readFileSync(new URL('../ENGINEERING_STANDARD.md', import.meta.url), 'utf8');
  assert.match(standard, /\.agents\/skills\//);
  assert.match(standard, /`mypr`、`mydocs`、`myshuohua`/);
});

test('the two documentation skills keep their rule sets apart', () => {
  const docsRules = JSON.parse(readFileSync(new URL('../skills/mydocs/rules.json', import.meta.url), 'utf8'));
  const wordsRules = JSON.parse(readFileSync(new URL('../skills/myshuohua/rules.json', import.meta.url), 'utf8'));
  const docsIds = docsRules.rules.map((rule) => rule.id);
  const wordsIds = wordsRules.rules.map((rule) => rule.id);
  assert.deepEqual(docsIds.sort(), ['readme-headings', 'zh-en-parity']);
  assert.deepEqual(wordsIds.sort(), ['banned-phrases', 'bullet-sentences', 'duplicate-sentences', 'paragraph-length', 'semicolon-density', 'sentence-length', 'term-casing', 'term-preference']);
  assert.equal(docsIds.some((id) => wordsIds.includes(id)), false, 'rule ids must not overlap');
});

test('each skill names its own checker and does not ship the other one', () => {
  const pairs = [
    ['mydocs', 'scripts/lint-docs.mjs', 'scripts/lint-shuohua.mjs'],
    ['myshuohua', 'scripts/lint-shuohua.mjs', 'scripts/lint-docs.mjs'],
  ];
  for (const [name, own, foreign] of pairs) {
    const body = readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(body, new RegExp(`skills/${name}/${own}`), `${name} must document its own checker`);
    assert.equal(existsSync(new URL(`../skills/${name}/${foreign}`, import.meta.url)), false, `${name} must not ship ${foreign}`);
  }
});

test('the wording reference lives with the wording skill only', () => {
  assert.equal(existsSync(new URL('../skills/mydocs/references/language-zh.md', import.meta.url)), false);
  assert.equal(existsSync(new URL('../skills/myshuohua/references/language-zh.md', import.meta.url)), true);
});
