// 技能注册表（D45、D55、D56、D57）：磁盘上现在有哪些技能是一条系统事实，与模式选了哪几件无关（D46）。
// 发现走四个固定目录的先后，同名只取最靠前那一份的整份，被忽略的那一份留一条诊断（D57）；
// 目录里出现 SKILL.md 就当技能根，不再往里递归找第二份（D45）。
// 头部是 YAML frontmatter（D49）：`name` 与 `description` 必填，`metadata` 里本项目只读 `ligule-requires` 那一键（D56）。
// 一份技能的头部解不开就整份不载入，但原因不静默：诊断交给装载侧记日志，也汇进系统提示里那一句说明。
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { isWithin } from '../capability/paths.js';
import { CONFIG_DIRECTORY } from './config-file.js';
import { KernelError } from './error.js';

export const SKILL_FILE = 'SKILL.md';
export const SKILLS_DIRECTORY = 'skills';
// 名字的字符集与两个长度上限照 Agent Skills 规范那一档（D49）：超限是头部写错了，不是「少一段说明」还能继续。
const NAME_LIMIT = 64;
const NAME_FORM = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DESCRIPTION_LIMIT = 1024;
// 元数据预算是一个常量（D55）：这一段字节每一次请求都要付，把它做成配置项等于让每台机器重新调一次。
export const SKILL_METADATA_BUDGET_BYTES = 8_000;
// 规范位置那一棵目录树里不属于技能的东西，与文件工具用的是同两个名字。
const SKIPPED_DIRECTORIES = ['node_modules', '.git'];

export interface SkillEntry {
  name: string;
  description: string;
  requires: string[];
  // 技能根：含 SKILL.md 的那一个目录。`read` 动作的文件边界就是它，与工作区边界是两套（D50）。
  root: string;
  file: string;
}

export interface SkillDiagnostic {
  code: string;
  detail: string;
  path: string;
}

export interface SkillRegistry {
  skills: SkillEntry[];
  diagnostics: SkillDiagnostic[];
}

// 先后是固定的四步，不是「扫到哪个算哪个」：同名两份时，取哪一份必须与遍历顺序、文件时间都无关（D57）。
export function skillDirectories(projectRoot: string, userHome = homedir()): string[] {
  if (typeof projectRoot !== 'string' || projectRoot === '') throw new KernelError('skill_project_root_required');
  return [
    join(projectRoot, CONFIG_DIRECTORY, SKILLS_DIRECTORY),
    join(projectRoot, '.agents', SKILLS_DIRECTORY),
    join(userHome, CONFIG_DIRECTORY, SKILLS_DIRECTORY),
    join(userHome, '.agents', SKILLS_DIRECTORY),
  ];
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new KernelError('skill_file_read_failed', { cause: error, detail: path });
  }
}

// 头部与正文按同一处切：`---` 那一块之外就是交给模型的正文。
function splitSkillDocument(text: string): { head: string | undefined; body: string } {
  const opening = text.match(/^---[ \t]*\r?\n/);
  if (opening?.index !== 0) return { head: undefined, body: text };
  const rest = text.slice(opening[0].length);
  const closing = rest.match(/^---[ \t]*$/m);
  if (closing?.index === undefined) return { head: undefined, body: text };
  return { head: rest.slice(0, closing.index), body: rest.slice(closing.index + closing[0].length).replace(/^[ \t]*\r?\n/, '') };
}

// `metadata` 那一格按规范是自由键值（D49）：认不出的键原样留着，只把本项目要读的那一键取出来。
function readRequires(metadata: unknown): string[] {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const declared = (metadata as Record<string, unknown>)['ligule-requires'];
  return typeof declared === 'string' ? declared.split(/\s+/).filter((token) => token !== '') : [];
}

function checkedSkill(text: string, file: string): SkillEntry {
  const { head: source } = splitSkillDocument(text);
  if (source === undefined) throw new KernelError('skill_frontmatter_missing', { detail: `${file} has no YAML frontmatter` });
  let head: unknown;
  try {
    head = parse(source);
  } catch (error) {
    throw new KernelError('skill_frontmatter_invalid', { cause: error, detail: file });
  }
  if (head === null || typeof head !== 'object' || Array.isArray(head)) {
    throw new KernelError('skill_frontmatter_invalid', { detail: `${file} is not a mapping` });
  }
  const fields = head as Record<string, unknown>;
  const name = fields.name;
  const description = fields.description;
  if (typeof name !== 'string' || !NAME_FORM.test(name)) {
    throw new KernelError('skill_name_invalid', { detail: `${name} in ${file} (lowercase letters, digits and single hyphens)` });
  }
  if (name.length > NAME_LIMIT) {
    throw new KernelError('skill_name_invalid', { detail: `${name} in ${file} is longer than ${NAME_LIMIT} characters` });
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw new KernelError('skill_description_missing', { detail: file });
  }
  if (description.length > DESCRIPTION_LIMIT) {
    throw new KernelError('skill_description_too_long', { detail: `${file} declares ${description.length} characters, the limit is ${DESCRIPTION_LIMIT}` });
  }
  return { name, description, requires: readRequires(fields.metadata), root: resolve(file, '..'), file };
}

// 一个目录里直接放着的子目录才是技能根；没有 SKILL.md 的那一种整棵跳过，往里递归找第二份是 D45 不要的形状。
async function childrenOf(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    // 四个目录本来就可以少几个：没有这一处不是错误，其余读失败才是。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new KernelError('skill_directory_read_failed', { cause: error, detail: directory });
  }
  return entries
    .filter((entry) => entry.isDirectory() && !SKIPPED_DIRECTORIES.includes(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export async function discoverSkills(directories: string[]): Promise<SkillRegistry> {
  const loaded = new Map<string, SkillEntry>();
  const diagnostics: SkillDiagnostic[] = [];
  for (const directory of directories) {
    for (const child of await childrenOf(directory)) {
      const file = join(directory, child, SKILL_FILE);
      const text = await readIfExists(file);
      if (text === undefined) continue;
      let skill: SkillEntry;
      try {
        skill = checkedSkill(text, file);
      } catch (error) {
        const failure = error as KernelError;
        diagnostics.push({ code: failure.code ?? 'skill_file_read_failed', detail: failure.detail ?? failure.message, path: file });
        continue;
      }
      const kept = loaded.get(skill.name);
      if (kept !== undefined) {
        diagnostics.push({
          code: 'skill_name_conflict',
          detail: `${skill.name} at ${skill.root} is ignored; the loaded one is ${kept.root}`,
          path: file,
        });
        continue;
      }
      loaded.set(skill.name, skill);
    }
  }
  const skills = [...loaded.values()].sort((left, right) => left.name.localeCompare(right.name));
  return { skills, diagnostics };
}

// 预算算在整段上：标题、每一条说明与末尾那句诊断都在这一格里（I6）。
// 超了就整份目录都不内联——半份说明比一句「用 search 去查」更难读（D55）。
const CATALOG_HEADING = 'Skills are packaged instructions kept on disk. Each line is `name: description`. '
  + 'Call skill with action "activate" and the name to load one; its supporting files come back with action "read".';
const CATALOG_FALLBACK = 'Skills are packaged instructions kept on disk, and there are too many to list here. '
  + 'Call skill with action "search" and a query to find one, then action "activate" with its name; supporting files come with action "read".';

export function formatSkillCatalog(registry: SkillRegistry, budgetBytes = SKILL_METADATA_BUDGET_BYTES): string {
  const note = registry.diagnostics.length === 0
    ? ''
    : `\n[${registry.diagnostics.length} skill file(s) were not loaded, the host log names them]`;
  const listed = `${CATALOG_HEADING}\n${registry.skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')}`;
  if (Buffer.byteLength(`${listed}${note}`, 'utf8') <= budgetBytes) return `${listed}${note}`;
  return `${CATALOG_FALLBACK}${note}`;
}

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== '');

// 词法打分，不引检索库（D55）：`name` 的精确与前缀匹配先排，其余按 `name` 与 `description` 上的 BM25 一类计分。
// 技能数量在这一步还是几十份的量，这一点面积上词法能区分开的东西已经够区分。
export function searchSkills(skills: SkillEntry[], query: string, limit = 5): SkillEntry[] {
  const wanted = [...new Set(wordsOf(query))];
  if (skills.length === 0 || wanted.length === 0) return [];
  const needle = query.trim().toLowerCase();
  // 名字里的词比说明里的词更能说明「就是这一个」，所以名字算两遍：同一条 BM25 计分上，词频翻倍就是权重翻倍。
  const documents = skills.map((skill) => ({ skill, words: wordsOf(`${skill.name} ${skill.name} ${skill.description}`) }));
  const average = documents.reduce((total, document) => total + document.words.length, 0) / documents.length;
  const scored = documents.map((document) => {
    const name = document.skill.name.toLowerCase();
    // 名字对上比内容对上更有意义，这一档先于词法分（D55）。
    const direct = name === needle ? 4 : name.startsWith(needle) ? 2 : 0;
    let lexical = 0;
    for (const word of wanted) {
      const frequency = document.words.filter((item) => item === word).length;
      if (frequency === 0) continue;
      const containing = documents.filter((other) => other.words.includes(word)).length;
      const inverse = Math.log(1 + (documents.length - containing) / containing);
      lexical += (inverse * frequency * 2.2) / (frequency + 1.2 * (0.75 + 0.25 * (document.words.length / average)));
    }
    return { skill: document.skill, score: direct + lexical };
  });
  return scored
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
    .slice(0, limit)
    .map((item) => item.skill);
}

// 正文与摘要一次读齐：摘要算在原始字节上，改了 SKILL.md 就换一个摘要（D53 要的是能判出「模型看的还是旧版」）。
// 交回模型的那一份去掉了头部：头部是装载侧读过的结构化字段，重复注入只是占预算。
export async function readSkillBody(skill: SkillEntry): Promise<{ body: string; bytes: number; digest: string }> {
  const bytes = await readFile(skill.file).catch((error: NodeJS.ErrnoException) => {
    throw new KernelError('skill_file_read_failed', { cause: error, detail: skill.file });
  });
  const text = bytes.toString('utf8');
  return {
    body: splitSkillDocument(text).body,
    bytes: bytes.length,
    digest: createHash('sha256').update(bytes).digest('hex').slice(0, 12),
  };
}

// 支撑文件的清单与读取都锁在那一个技能根里（D50）：工作区的 `read` 管不到这里，这里也越不出边界。
// 词法与真实路径各查一次：前者拦 `../`，后者拦符号链接，两条都报同一个码，越界就是越界。
async function withinRoot(skill: SkillEntry, path: string): Promise<string> {
  const absolute = resolve(skill.root, path);
  if (!isWithin(skill.root, absolute)) {
    throw new KernelError('skill_path_escapes_root', { detail: `${path} resolves to ${absolute}, outside ${skill.root}` });
  }
  const realRoot = await realpath(skill.root).catch((error: NodeJS.ErrnoException) => {
    throw new KernelError('skill_file_read_failed', { cause: error, detail: skill.root });
  });
  const real = await realpath(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new KernelError('skill_file_not_found', { detail: `${path} in ${skill.name}` });
    throw new KernelError('skill_file_read_failed', { cause: error, detail: absolute });
  });
  if (!isWithin(realRoot, real)) {
    throw new KernelError('skill_path_escapes_root', { detail: `${path} leads to ${real} through a link, outside ${realRoot}` });
  }
  return real;
}

export async function listSkillFiles(skill: SkillEntry, limit: number): Promise<{ files: string[]; more: boolean }> {
  const found: string[] = [];
  let more = false;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (SKIPPED_DIRECTORIES.includes(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && full !== skill.file) {
        if (found.length === limit) {
          more = true;
          return;
        }
        found.push(toPosix(relative(skill.root, full)));
      }
    }
  };
  await walk(skill.root);
  return { files: found, more };
}

export async function readSkillFile(skill: SkillEntry, path: string): Promise<Buffer> {
  const target = await withinRoot(skill, path);
  try {
    return await readFile(target);
  } catch (error) {
    throw new KernelError('skill_file_read_failed', { cause: error, detail: target });
  }
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}
