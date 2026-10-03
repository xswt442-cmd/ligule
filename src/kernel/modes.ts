// 模式是一份命名的装配清单（D35）：三格——`tools` 选本次运行注册表里的哪几件交给模型，
// `prompt` 选哪几段提示词，`sources` 列扩展与技能的来源。一个模式一份 TOML，文件名就是模式名（D43）。
// 查找从低到高分三层：随包那一份、`~/.ligule/modes/`、`<项目根>/.ligule/modes/`；同名只取最高那层的整份，
// 不做跨层合并——把「这一次运行装了什么」写成两处，读的时候就对不上了（D35 放弃「模式引用模式」是同一条理由）。
// 项目层那份不许写 `sources`（D46）：这一格决定往进程里加载谁的代码，不由别人写的仓库替本机决定。
// `prompt` 与 `sources` 这两格这一轮只解析与校验：提示词段的按名选择要等片段注册表，
// 扩展文件的加载要等 D37 那条窄接口。写了非空内容而装载还不接，当场失败，不装作生效了。
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { CONFIG_DIRECTORY } from './config-file.js';
import { KernelError } from './error.js';

export const MODE_DIRECTORY = 'modes';
// 不选模式时装的是随包的这一份，也就是 D3 那八件，行为与阶段一相同。
export const DEFAULT_MODE = 'minimal';
const MODE_FIELDS = ['tools', 'prompt', 'sources'];

export type ModeLayer = 'shipped' | 'user' | 'project';

export interface ModeFile {
  name: string;
  layer: ModeLayer;
  path: string;
  tools: string[] | '*';
  prompt: string[] | '*';
  sources: string[];
}

export interface ModeDirectories {
  shipped: string;
  user: string;
  project: string;
}

// 内核在装载之后交给 applyMode 的是这两件事：读出登记了哪些工具，以及把没选中的藏起来（I4 只收紧）。
export interface ModeTarget {
  list(): string[];
  restrict(names: string[]): () => void;
}

export function modeDirectories(projectRoot: string, shippedDirectory: string, userHome = homedir()): ModeDirectories {
  if (typeof projectRoot !== 'string' || projectRoot === '') throw new KernelError('mode_project_root_required');
  return {
    shipped: shippedDirectory,
    user: join(userHome, CONFIG_DIRECTORY, MODE_DIRECTORY),
    project: join(projectRoot, CONFIG_DIRECTORY, MODE_DIRECTORY),
  };
}

// 模式名直接拼进路径：带斜杠或 `..` 的名字会指着这三个目录之外去读文件，太长的名字在文件系统里没有意义，
// 所以形状与长度都在这里一次查掉。
function checkedName(name: string): string {
  if (typeof name !== 'string' || name.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new KernelError('mode_name_invalid', { detail: String(name) });
  }
  return name;
}

// 从最高那一层往下找，第一个存在的文件就是这一份模式的全文。
async function readDocument(name: string, directories: ModeDirectories): Promise<{ layer: ModeLayer; path: string; text: string }> {
  const order: { layer: ModeLayer; directory: string }[] = [
    { layer: 'project', directory: directories.project },
    { layer: 'user', directory: directories.user },
    { layer: 'shipped', directory: directories.shipped },
  ];
  const tried: string[] = [];
  for (const candidate of order) {
    const path = join(candidate.directory, `${name}.toml`);
    tried.push(path);
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      // 三层里任何一层都可以没有这个名字，缺文件继续往下找；其余读失败是真问题。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new KernelError('mode_file_read_failed', { cause: error, detail: `${candidate.layer}: ${path}` });
    }
    return { layer: candidate.layer, path, text };
  }
  throw new KernelError('mode_unknown', { detail: `${name} (looked in ${tried.join(', ')})` });
}

function readNameList(value: unknown, field: string, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new KernelError('mode_field_invalid', { detail: `${field} must be an array of names: ${path}` });
  }
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item === '') {
      throw new KernelError('mode_field_invalid', { detail: `${field} takes non-empty strings only: ${path}` });
    }
    // 同名两次没有第二种含义，收下只会让「选了哪几件」在别处读出来是另一回事。
    if (names.includes(item)) throw new KernelError('mode_field_duplicate', { detail: `${field} names ${item} twice: ${path}` });
    names.push(item);
  }
  return names;
}

function readNames(value: unknown, field: string, path: string, allowStar: boolean): string[] | '*' {
  if (allowStar && value === '*') return '*';
  return readNameList(value, field, path);
}

export async function loadMode(name: string, directories: ModeDirectories): Promise<ModeFile> {
  const file = await readDocument(checkedName(name), directories);
  let document: unknown;
  try {
    document = parse(file.text);
  } catch (error) {
    // 写坏的模式不该以「少了一格」的形式静默生效。
    throw new KernelError('mode_file_invalid', { cause: error, detail: `${file.layer}: ${file.path}` });
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new KernelError('mode_file_invalid', { detail: file.path });
  }
  const fields = document as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    // 认不出的格名会被整份忽略，写的人以为生效了而没有——列在这里而不是默默收下。
    if (!MODE_FIELDS.includes(key)) throw new KernelError('mode_field_unknown', { detail: `${key}: ${file.path}` });
  }
  for (const key of MODE_FIELDS) {
    if (fields[key] === undefined) throw new KernelError('mode_field_missing', { detail: `${key} (required by every mode): ${file.path}` });
  }
  const tools = readNames(fields.tools, 'tools', file.path, true);
  const prompt = readNames(fields.prompt, 'prompt', file.path, true);
  const sources = readNameList(fields.sources, 'sources', file.path);
  // 空数组是「这一格不选」，写进文件里看得见；非空而装载还不接就是错。
  if (prompt !== '*' && prompt.length > 0) {
    throw new KernelError('mode_field_unsupported', { detail: `prompt is not selected by the loader yet (it lands with the fragment registry): ${file.path}` });
  }
  if (sources.length > 0) {
    // 项目层那份出自别人写的仓库：这一格决定往进程里加载谁的代码，不由它替本机决定（D46）。
    // 空数组允许，因为随包的那份可以原样拷进项目目录改前两格。
    if (file.layer === 'project') {
      throw new KernelError('mode_project_field_forbidden', { detail: `sources cannot be set by the project layer (D46): ${file.path}` });
    }
    throw new KernelError('mode_field_unsupported', { detail: `sources are loaded by the extension carrier, not yet by the mode loader: ${file.path}` });
  }
  return { name, layer: file.layer, path: file.path, tools, prompt, sources };
}

// 选中的一栏与注册表对得上才算数：模式写了一件本次运行没登记的工具，那是清单写错，
// 而不是「少一件」——静默少一件会让装配清单读出来的与模型看见的不是一回事（I2）。
export function applyMode(kernel: ModeTarget, mode: ModeFile): string[] {
  const registered = kernel.list();
  const selected = mode.tools;
  if (selected === '*') return registered;
  for (const name of selected) {
    if (!registered.includes(name)) {
      throw new KernelError('mode_tool_unregistered', { detail: `${name} (mode ${mode.name}; registered: ${registered.join(', ') || 'none'})` });
    }
  }
  const hidden = registered.filter((name) => !selected.includes(name));
  if (hidden.length > 0) kernel.restrict(hidden);
  return selected;
}
