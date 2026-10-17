// 提示模板从用户目录和项目目录加载，项目模板优先。
// 命令名称由相对路径生成，例如 `git/release/prepare.md` 对应 `/git:release:prepare`。
// 目录递归扫描；模板只由 Host 展开，确保 CLI、TUI 和 Desktop 使用相同结果。
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import { CONFIG_DIRECTORY, dataRoot } from './config-file.js';
import { splitFrontmatter } from './frontmatter.js';
import { KernelError } from './error.js';

export const PROMPTS_DIRECTORY = 'prompts';
const TEMPLATE_SUFFIX = '.md';
// 目录和文件名共同构成命令名称；每段只能使用小写字母、数字和单个连字符。
const NAME_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DESCRIPTION_LIMIT = 1024;
const SKIPPED_DIRECTORIES = ['node_modules', '.git'];
// 支持完整参数和位置参数两种占位符。
// 同一套正则用于占位符替换和检测。
const PLACEHOLDER_SOURCE = '\\$ARGUMENTS|\\$([1-9])(?![0-9])';
const PLACEHOLDER = new RegExp(PLACEHOLDER_SOURCE, 'g');
const HAS_PLACEHOLDER = new RegExp(PLACEHOLDER_SOURCE);

export interface TemplateEntry {
  // 注册表保存不带前导斜杠的命令名；斜杠只用于用户输入。
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

// 加载顺序与模式文件一致：项目模板优先于用户模板。
export function templateDirectories(projectRoot: string, userHome = homedir()): { layer: TemplateEntry['layer']; directory: string }[] {
  if (typeof projectRoot !== 'string' || projectRoot === '') throw new KernelError('template_project_root_required');
  return [
    { layer: 'project', directory: join(projectRoot, CONFIG_DIRECTORY, PROMPTS_DIRECTORY) },
    { layer: 'user', directory: join(dataRoot(userHome), PROMPTS_DIRECTORY) },
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
    // 模板目录可以不存在；其他读取错误应直接返回。
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
      // 命令名称必须能由用户原样输入；路径段含非法字符时拒绝该模板。
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

// 只有符合命令名格式的斜杠前缀才作为模板调用；未知或拼错的命令需明确报错。
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

// 使用 shell 引号规则解析参数；引号不配对时返回错误，避免改变用户输入含义。
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
  // 同时替换两类占位符，避免参数中的 `$1` 被第二次替换。
  const text = body.replace(PLACEHOLDER, (match, digit: string | undefined) =>
    (digit === undefined ? args.join(' ') : args[Number(digit) - 1] ?? ''));
  // 模板没有占位符但用户提供了参数时，将参数原文追加到模板正文之后。
  const appended = argumentText !== '' && !HAS_PLACEHOLDER.test(body);
  return {
    text: appended ? `${text.trimEnd()}\n\n${argumentText}\n` : text,
    arguments: args,
    source: template.file,
    digest: createHash('sha256').update(bytes).digest('hex').slice(0, 12),
  };
}
