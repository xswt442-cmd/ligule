// 提示模板注册表（D45、D54）：两处目录——`<项目根>/.ligule/prompts/` 与 `~/.ligule/prompts/`，项目层优先。
// 命令名从相对路径推出来（`git/release/prepare.md` 就是 `/git:release:prepare`），头部不再写 `name`，
// 免得路径与字段成为两份真相。目录要递归：嵌套本身就是人组织这些文件的方式。
// 参照实现只读根下一层（`pi/packages/coding-agent/docs/prompt-templates.md:55`），这一条与它不同。
// 展开只发生在 Host（D54）：命令行、终端界面与桌面前端因此看到的是同一份展开结果与同一条记录。
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import { CONFIG_DIRECTORY } from './config-file.js';
import { splitFrontmatter } from './frontmatter.js';
import { KernelError } from './error.js';

export const PROMPTS_DIRECTORY = 'prompts';
const TEMPLATE_SUFFIX = '.md';
// 目录名与文件名一起构成命令名，所以每一段都要能被人敲出来：小写字母、数字与单个连字符（与技能名同一档）。
const NAME_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DESCRIPTION_LIMIT = 1024;
const SKIPPED_DIRECTORIES = ['node_modules', '.git'];
// 第一版只认这两种占位（D54）：全部参数与位置参数。默认值与切片等真实模板需要时再补。
// 同一条写法用两遍：一次替换，一次判断模板里到底有没有占位，所以只留一份模式。
const PLACEHOLDER_SOURCE = '\\$ARGUMENTS|\\$([1-9])(?![0-9])';
const PLACEHOLDER = new RegExp(PLACEHOLDER_SOURCE, 'g');
const HAS_PLACEHOLDER = new RegExp(PLACEHOLDER_SOURCE);

export interface TemplateEntry {
  // 命令名不含前导斜杠：斜杠是界面与用户之间的那一层写法，注册表里存的是名字本身。
  command: string;
  description: string;
  hint: string | undefined;
  file: string;
  layer: 'project' | 'user';
}

export interface TemplateDiagnostic {
  code: string;
  detail: string;
  path: string;
}

export interface TemplateRegistry {
  templates: TemplateEntry[];
  diagnostics: TemplateDiagnostic[];
}

export interface ExpandedTemplate {
  text: string;
  arguments: string[];
  source: string;
  digest: string;
}

// 先后两条与模式文件同一条规则（D36、D43）：靠近仓库的那一份胜出。
export function templateDirectories(projectRoot: string, userHome = homedir()): { layer: TemplateEntry['layer']; directory: string }[] {
  if (typeof projectRoot !== 'string' || projectRoot === '') throw new KernelError('template_project_root_required');
  return [
    { layer: 'project', directory: join(projectRoot, CONFIG_DIRECTORY, PROMPTS_DIRECTORY) },
    { layer: 'user', directory: join(userHome, CONFIG_DIRECTORY, PROMPTS_DIRECTORY) },
  ];
}

function commandOf(root: string, file: string): string {
  return relative(root, file).split(sep).join('/').slice(0, -TEMPLATE_SUFFIX.length).split('/').join(':');
}

async function markdownFiles(directory: string, found: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    // 两处目录本来就可以都没有：少一处不是错误，其余读失败才是。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return found;
    throw new KernelError('template_directory_read_failed', { cause: error, detail: directory });
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.includes(entry.name)) await markdownFiles(full, found);
    } else if (entry.isFile() && entry.name.endsWith(TEMPLATE_SUFFIX) && entry.name.length > TEMPLATE_SUFFIX.length) {
      found.push(full);
    }
  }
  return found;
}

function checkedTemplate(text: string, file: string, command: string, layer: TemplateEntry['layer']): TemplateEntry {
  const { head } = splitFrontmatter(text);
  if (head === undefined) throw new KernelError('template_frontmatter_missing', { detail: `${file} has no YAML frontmatter` });
  let fields: unknown;
  try {
    fields = parse(head);
  } catch (error) {
    throw new KernelError('template_frontmatter_invalid', { cause: error, detail: file });
  }
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new KernelError('template_frontmatter_invalid', { detail: `${file} is not a mapping` });
  }
  const { description, argumentHint, 'argument-hint': hint } = fields as Record<string, unknown>;
  if (typeof description !== 'string' || description.trim() === '') throw new KernelError('template_description_missing', { detail: file });
  if (description.length > DESCRIPTION_LIMIT) {
    throw new KernelError('template_description_too_long', { detail: `${file} declares ${description.length} characters, the limit is ${DESCRIPTION_LIMIT}` });
  }
  const hintValue = argumentHint ?? hint;
  if (hintValue !== undefined && typeof hintValue !== 'string') {
    throw new KernelError('template_hint_invalid', { detail: `argument-hint in ${file} must be a string` });
  }
  return { command, description, hint: hintValue === undefined ? undefined : String(hintValue), file, layer };
}

export async function discoverTemplates(directories: { layer: TemplateEntry['layer']; directory: string }[]): Promise<TemplateRegistry> {
  const loaded = new Map<string, TemplateEntry>();
  const diagnostics: TemplateDiagnostic[] = [];
  for (const { layer, directory } of directories) {
    for (const file of await markdownFiles(directory)) {
      const command = commandOf(directory, file);
      const segments = command.split(':');
      // 命令名要能原样被打出来：段名里有一个不认的字符，这个模板就进不了调用那一条路。
      if (!segments.every((segment) => NAME_SEGMENT.test(segment))) {
        diagnostics.push({ code: 'template_command_invalid', detail: `${command} from ${file} (segments are lowercase letters, digits and single hyphens)`, path: file });
        continue;
      }
      let text;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        diagnostics.push({ code: 'template_file_read_failed', detail: `${file}: ${(error as NodeJS.ErrnoException).code ?? 'unreadable'}`, path: file });
        continue;
      }
      let template: TemplateEntry;
      try {
        template = checkedTemplate(text, file, command, layer);
      } catch (error) {
        const failure = error as KernelError;
        diagnostics.push({ code: failure.code ?? 'template_frontmatter_invalid', detail: failure.detail ?? failure.message, path: file });
        continue;
      }
      const kept = loaded.get(command);
      if (kept !== undefined) {
        diagnostics.push({ code: 'template_name_conflict', detail: `${template.file} is ignored; the loaded one is ${kept.file}`, path: file });
        continue;
      }
      loaded.set(command, template);
    }
  }
  return {
    templates: [...loaded.values()].sort((left, right) => left.command.localeCompare(right.command)),
    diagnostics,
  };
}

// 只有形状是「合法命令名」的那一段才算调用：`/etc/hosts 看一下` 里的斜杠不是命令，
// 而 `/revew foo` 这种拼错的形状必须说一声，静默把原文交给模型只会让人以为模板没生效。
const INVOCATION = /^\/([a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)*)(?=\s|$)/;

export function parseInvocation(text: string): { command: string; arguments: string } | undefined {
  const match = text.match(INVOCATION);
  if (match === null) return undefined;
  return { command: match[1], arguments: text.slice(match[0].length).trim() };
}

export function findTemplate(registry: TemplateRegistry, command: string): TemplateEntry {
  const found = registry.templates.find((template) => template.command === command);
  if (found === undefined) {
    const names = registry.templates.map((template) => `/${template.command}`);
    throw new KernelError('template_unknown', {
      detail: names.length === 0
        ? `no prompt template is loaded, so /${command} cannot be expanded`
        : `no prompt template named /${command}; loaded: ${names.slice(0, 8).join(', ')}${names.length > 8 ? `, and ${names.length - 8} more` : ''}`,
    });
  }
  return found;
}

// 参数按 shell 那一套引号切（参照实现同一条：`pi/packages/coding-agent/docs/prompt-templates.md:49`）。
// 引号不成对就报出去：静默把半截引号当成内容，展开出来的是用户没说的那句话。
export function splitArguments(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | undefined;
  let started = false;
  for (const character of text) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (quote !== undefined) throw new KernelError('template_arguments_unbalanced', { detail: `${text} leaves a ${quote} quote open` });
  if (started) tokens.push(current);
  return tokens;
}

export async function expandTemplate(template: TemplateEntry, argumentText: string): Promise<ExpandedTemplate> {
  const args = splitArguments(argumentText);
  let bytes;
  try {
    bytes = await readFile(template.file);
  } catch (error) {
    throw new KernelError('template_file_read_failed', { cause: error, detail: template.file });
  }
  const body = splitFrontmatter(bytes.toString('utf8')).body;
  // 一次扫完两种占位：先替 `$ARGUMENTS` 再替 `$1` 的话，参数里带一个 `$1` 就会被第二次替换吃掉。
  const text = body.replace(PLACEHOLDER, (match, digit: string | undefined) =>
    (digit === undefined ? args.join(' ') : args[Number(digit) - 1] ?? ''));
  // 模板一个占位都没写而人带了参数时，把参数原文接在正文之后：那几句话是用户输入的，丢掉等于没收到。
  const appended = argumentText !== '' && !HAS_PLACEHOLDER.test(body);
  return {
    text: appended ? `${text.trimEnd()}\n\n${argumentText}\n` : text,
    arguments: args,
    source: template.file,
    digest: createHash('sha256').update(bytes).digest('hex').slice(0, 12),
  };
}
