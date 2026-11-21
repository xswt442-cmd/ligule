#!/usr/bin/env node
// 文档骨架的机械检查。零依赖，够用就好。
//
//   node .agents/skills/mydocs/scripts/lint-docs.mjs README.md README.en.md docs
//   node .agents/skills/mydocs/scripts/lint-docs.mjs --strict .
//   node .agents/skills/mydocs/scripts/lint-docs.mjs --json .
//   node .agents/skills/mydocs/scripts/lint-docs.mjs --rules
//
// 退出码：0 干净，1 有 error（或 --strict 下有 warning），2 用法或读文件出错。
//
// 这里只查内容和文件的对应关系：首页有没有装内部话题、中英两版骨架对不对得上。
// 分号、句长、术语写法、固定短语归 myshuohua 的 lint-shuohua.mjs。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// rules.json 与检查器不同层：脚本在 scripts/，规则在 skill 根。
const CONFIG = JSON.parse(readFileSync(join(HERE, '..', 'rules.json'), 'utf8'));
const RULE = new Map(CONFIG.rules.map((rule) => [rule.id, rule]));

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'vendor', 'testplace',
  '.venv', '__pycache__', 'target', '.next', 'bin', 'obj', 'coverage',
]);

const args = process.argv.slice(2);
if (args.includes('--rules')) {
  for (const rule of CONFIG.rules) console.log(`${rule.level.padEnd(8)} ${rule.id}\n         ${rule.why}`);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(0);
}

const strict = args.includes('--strict');
const asJson = args.includes('--json');
const targets = args.filter((arg) => !arg.startsWith('-'));

function collect(target, out = []) {
  const stat = statSync(target);
  if (stat.isDirectory()) {
    for (const name of readdirSync(target)) {
      if (SKIP_DIRS.has(name)) continue;
      collect(join(target, name), out);
    }
  } else if (/\.(md|markdown)$/i.test(target)) {
    out.push(target);
  }
  return out;
}

// 代码块里的 ### 不是标题，注释里的链接不算段落。换成等长空格，行号就不会漂。
function mask(lines) {
  let fenced = false;
  let marker = '';
  return lines.map((line) => {
    const open = line.trimStart().match(/^(```+|~~~+)/);
    if (fenced) {
      if (open && open[1][0] === marker) fenced = false;
      return ' '.repeat(line.length);
    }
    if (open) {
      fenced = true;
      marker = open[1][0];
      return ' '.repeat(line.length);
    }
    return line
      .replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
      .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length))
      // 头部常见的 <div><img><a> 徽章不参与骨架计数，否则中英两版的换行差异会被当成错位。
      .replace(/<[^>]+>/g, (m) => ' '.repeat(m.length));
  });
}

const hasProse = (text) => /[\p{L}\p{N}]/u.test(text);
const isBullet = (line) => /^\s*[-*+]\s+/.test(line);
const isHeading = (line) => /^#{1,6}\s/.test(line);
const isTable = (line) => /^\s*\|/.test(line);

// 骨架指二级标题数、段落数、条目数。中英两版应当一致。
function skeleton(lines) {
  const body = mask(lines);
  const counts = { h2: 0, paragraphs: 0, bullets: 0 };
  lines.forEach((line, index) => {
    const masked = body[index];
    if (!line.trim()) return;
    if (masked.trim() && isHeading(masked)) {
      if (/^##\s/.test(masked)) counts.h2 += 1;
      return;
    }
    if (isBullet(line)) counts.bullets += 1;
    // 只剩分隔符或空白的行（例如徽章之间的「·」）不是段落。
    else if (!isTable(line) && hasProse(masked)) counts.paragraphs += 1;
  });
  return counts;
}

const findings = [];
// 文档里要引用坏例子，这类地方得能关掉某条规则。写法：
//   <!-- lint-ignore-file rule -->        整个文件不算这条
//   <!-- lint-ignore-next-line rule -->  下一行不算
let SUPPRESS = { file: new Set(), byLine: new Map() };

function suppressions(lines) {
  const file = new Set();
  const byLine = new Map();
  lines.forEach((raw, index) => {
    for (const match of raw.matchAll(/<!--\s*lint-(ignore-file|ignore-next-line|disable-next-line)\s+([\w-]+(?:[\s,]+[\w-]+)*?)\s*-->/g)) {
      const ids = match[2].split(/[\s,]+/).filter(Boolean);
      if (match[1] === 'ignore-file') ids.forEach((id) => file.add(id));
      else {
        const next = index + 2;
        byLine.set(next, new Set([...(byLine.get(next) ?? []), ...ids]));
      }
    }
  });
  return { file, byLine };
}

const add = (file, lines, rule, text) => {
  if (SUPPRESS.file.has(rule)) return;
  const candidates = Array.isArray(lines) ? lines : [lines];
  const line = candidates.find((n) => !SUPPRESS.byLine.get(n)?.has(rule));
  if (line === undefined) return;
  if (findings.some((item) => item.file === file && item.line === line && item.rule === rule)) return;
  findings.push({ file, line, rule, level: RULE.get(rule).level, text });
};

function checkFile(file, lines, pairCache) {
  SUPPRESS = suppressions(lines);
  const body = mask(lines);
  const stat = { file, h2: 0 };
  const atRoot = existsSync(join(dirname(file), '.git'));
  const name = basename(file).toLowerCase();
  const isReadme = /^readme(\.[a-z-]+)?\.md$/.test(name);

  // readme-headings：只管仓库首页。docs 子目录里的 README 有自己的结构。
  if (atRoot && isReadme) {
    const rule = RULE.get('readme-headings');
    body.forEach((line, index) => {
      const heading = line.match(/^##\s+(.+?)\s*$/);
      if (!heading) return;
      stat.h2 += 1;
      const title = heading[1].replace(/[*_`]/g, '').trim();
      const hit = rule.internal.find((word) => title.toLowerCase().includes(word.toLowerCase()));
      if (hit) add(file, index + 1, 'readme-headings', `「${title}」是内部文档的话题，确认要不要拆进 docs`);
    });
    if (stat.h2 > rule.maxH2) {
      add(file, 1, 'readme-headings', `README 有 ${stat.h2} 个二级标题，上限 ${rule.maxH2}。先看有没有能合并的`);
    }
  }

  // zh-en-parity：README.md 与 README.en.md 的骨架要对得上。一对只比一次。
  const paired = name === 'readme.md' ? 'README.en.md' : name === 'readme.en.md' ? 'README.md' : null;
  const dir = dirname(file);
  if (atRoot && paired && !pairCache.has(dir)) {
    pairCache.add(dir);
    let otherLines = null;
    try {
      otherLines = readFileSync(join(dir, paired), 'utf8').split(/\r?\n/);
    } catch {
      otherLines = null;
    }
    if (otherLines) {
      const mine = skeleton(lines);
      const theirs = skeleton(otherLines);
      const diffs = [];
      if (mine.h2 !== theirs.h2) diffs.push(`二级标题 ${mine.h2} / ${theirs.h2}`);
      if (mine.paragraphs !== theirs.paragraphs) diffs.push(`段落 ${mine.paragraphs} / ${theirs.paragraphs}`);
      if (mine.bullets !== theirs.bullets) diffs.push(`条目 ${mine.bullets} / ${theirs.bullets}`);
      if (diffs.length) {
        add(file, 1, 'zh-en-parity', `中英结构对不上（${basename(file)} / ${paired}）：${diffs.join('，')}`);
      }
    }
  }

  return stat;
}

if (!targets.length) targets.push('.');

const files = [];
for (const target of targets) {
  try {
    collect(target, files);
  } catch (error) {
    console.error(`读不到 ${target}：${error.message}`);
    process.exit(2);
  }
}

const pairCache = new Set();
const stats = files.map((file) => checkFile(file, readFileSync(file, 'utf8').split(/\r?\n/), pairCache));

findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

if (asJson) {
  console.log(JSON.stringify({ findings, stats }, null, 2));
} else {
  let current = '';
  for (const finding of findings) {
    if (finding.file !== current) {
      current = finding.file;
      const stat = stats.find((item) => item.file === finding.file);
      console.log(`\n${finding.file}${stat.h2 ? `  二级标题 ${stat.h2}` : ''}`);
    }
    console.log(`  ${String(finding.line).padStart(4)}  ${finding.level.padEnd(8)} ${finding.rule.padEnd(18)} ${finding.text}`);
  }
  const warnings = findings.filter((item) => item.level === 'warning').length;
  const infos = findings.filter((item) => item.level === 'info').length;
  console.log(`\n${files.length} 个文件，${warnings} 个 warning，${infos} 个 info`);
  if (!findings.length) console.log('没发现问题。');
}

process.exitCode = (strict && findings.some((item) => item.level === 'warning')) ? 1 : 0;
