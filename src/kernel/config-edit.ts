// 配置文件的写入侧（方案 7.2）：只换白名单里那几个标量字段的那一个值，其余字节一个不动。
// 为什么不用格式编辑库：本仓库装的 `smol-toml` 交回的是值而不是文档，整份重写会把注释、键的顺序与换行丢掉，
// 而这三样正是要保住的东西。这一条在原文里定位那一个值的跨度，只换它，行尾的注释留在原地；
// 换完整份读回来核对目标键等于要写的值，对不上就不落盘。
// ponytail: 认的形状只有「[表] 头之下的一条 `键 = 值`」与顶层那一条 `表.键 = 值`。嵌套表、数组表（工具规则表那一类）、
// 多行字符串与内联表都不在这一条路上，撞上就报 `config_edit_shape_unsupported` 且一个字都不写；
// 要覆盖那几种形状就换成带文档模型的编辑库（E10 那条选型还没经使用者确认）。
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse } from 'smol-toml';
import lockfile from 'proper-lockfile';
import { KernelError, KernelRuntimeError } from './error.js';

/** 一个可写字段：落在哪一条路径、值按什么形状收。 */
export type EditableField = {
  readonly path: readonly [string, string];
  readonly kind: 'string' | 'enum' | 'url' | 'envName';
  readonly oneOf?: readonly string[];
};

// 白名单由宿主持有：客户端说不出这一个键之外的事，也指不出一个文件路径（方案 7.2）。
export const EDITABLE: Readonly<Record<string, EditableField>> = {
  'model.api': { path: ['model', 'api'], kind: 'enum', oneOf: ['messages', 'chat-completions'] },
  'model.model': { path: ['model', 'model'], kind: 'string' },
  'model.baseURL': { path: ['model', 'baseURL'], kind: 'url' },
  'model.apiKeyEnv': { path: ['model', 'apiKeyEnv'], kind: 'envName' },
};

export function editableField(field: unknown): EditableField {
  if (typeof field !== 'string' || EDITABLE[field] === undefined) {
    throw new KernelError('config_field_unknown', { detail: `writable fields: ${Object.keys(EDITABLE).join(', ')}` });
  }
  return EDITABLE[field];
}

/** 值先按字段的形状收下来，再交回一份 TOML 写法与一份读回来核对要用的值。 */
export function encodeValue(field: EditableField, value: unknown): { literal: string; value: string } {
  if (field.kind === 'enum') {
    if (typeof value !== 'string' || !field.oneOf!.includes(value)) {
      throw new KernelError('config_field_value', { detail: `takes one of: ${field.oneOf!.join(', ')}` });
    }
    return { literal: JSON.stringify(value), value };
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KernelError('config_field_value', { detail: 'takes a non-empty string' });
  }
  const text = value.trim();
  if (field.kind === 'url') {
    let url: URL;
    try {
      url = new URL(text);
    } catch (cause) {
      throw new KernelError('config_field_value', { cause, detail: 'takes a full URL including the scheme' });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new KernelError('config_field_value', { detail: 'takes an http or https URL' });
    }
    // 凭据只走环境变量（D13、D60）：把 key 塞进地址里再写进配置文件，等于把秘密放进每一份读得到这份配置的地方。
    if (url.username !== '' || url.password !== '') {
      throw new KernelError('config_field_value', { detail: 'credentials do not belong in the address' });
    }
  }
  if (field.kind === 'envName' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    throw new KernelError('config_field_value', { detail: 'takes one environment variable name, not its value' });
  }
  return { literal: JSON.stringify(text), value: text };
}

type Line = { body: string; eol: string };

// 按行切开且把每一行的换行形状记下来：混着 CRLF 与 LF 的那一份文件接回去还是原来那一份。
function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const next = text.indexOf('\n', start);
    if (next === -1) {
      lines.push({ body: text.endsWith('\r') ? text.slice(start, -1) : text.slice(start), eol: '' });
      return lines;
    }
    const crlf = text[next - 1] === '\r';
    lines.push({ body: text.slice(start, crlf ? next - 1 : next), eol: crlf ? '\r\n' : '\n' });
    start = next + 1;
  }
}

const joined = (lines: Line[]): string => lines.map((line) => line.body + line.eol).join('');

function headerOf(body: string): string | null {
  // 数组表（`[[x]]`）也算一段的边界：交回一个空串，它永远不等于一个表名，但会切断上面那一段。
  if (/^[ \t]*\[\[/.test(body)) return '';
  const match = /^[ \t]*\[([^\s[\]]+)\][ \t]*(#.*)?$/.exec(body);
  return match === null ? null : match[1];
}

// 等号右边那一段：交回到注释或行尾之前那一个跨度。数组、内联表、没在本行闭上的引号都认不下来。
function valueSpan(body: string, from: number): number | null {
  let index = from;
  while (body[index] === ' ' || body[index] === '\t') index += 1;
  let quote = '';
  for (; index < body.length; index += 1) {
    const char = body[index];
    if (quote !== '') {
      if (quote === '"' && char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '#' || char === '[' || char === '{') break;
  }
  if (quote !== '') return null;
  if (body[index] === '[' || body[index] === '{') return null;
  let end = index;
  while (body[end - 1] === ' ' || body[end - 1] === '\t') end -= 1;
  return end > from ? end : null;
}

function replaceValue(body: string, equal: number, literal: string): string | null {
  let after = equal + 1;
  while (body[after] === ' ' || body[after] === '\t') after += 1;
  const end = valueSpan(body, after);
  if (end === null) return null;
  return `${body.slice(0, equal + 1)} ${literal}${body.slice(end)}`;
}

// 任意一条键行：补一行时要知道这一张表里最后那一条键落在哪儿。
const KEY_ANY = /^[ \t]*[^ \t=#]+[ \t]*=/;

function keyLine(body: string, key: string): { equal: number } | null {
  if (body.trimStart().startsWith('#')) return null;
  const match = /^[ \t]*([^ \t=#]+)[ \t]*=/.exec(body);
  if (match === null || match[1] !== key) return null;
  return { equal: body.indexOf('=', match[0].length - 1) };
}

/** 在原文里换掉那一个值：注释、其余键、键的顺序与每一行的换行形状都留着。键不存在时在那一张表里补一行。 */
export function editTomlValue(text: string, path: readonly [string, string], literal: string): { text: string; created: boolean } {
  const [table, key] = path;
  const lines = splitLines(text);
  const eol = lines.find((line) => line.eol !== '')?.eol ?? '\n';
  const first = lines.findIndex((line) => headerOf(line.body) !== null);
  // 顶层那一段（第一张表的头之前）写的 `表.键 = 值` 与表里那一条是同一件事。
  const scope = first === -1 ? lines.length : first;
  for (let index = 0; index < scope; index += 1) {
    const found = keyLine(lines[index].body, `${table}.${key}`);
    if (found === null) continue;
    const replaced = replaceValue(lines[index].body, found.equal, literal);
    if (replaced === null) throw new KernelError('config_edit_shape_unsupported', { detail: 'that value is not one line' });
    lines[index].body = replaced;
    return { text: joined(lines), created: false };
  }
  if (first === -1) {
    return appendTable(lines, eol, table, key, literal);
  }
  const block = lines.findIndex((line, index) => index >= first && headerOf(line.body) === table);
  if (block === -1) {
    return appendTable(lines, eol, table, key, literal);
  }
  const until = lines.findIndex((line, index) => index > block && headerOf(line.body) !== null);
  const end = until === -1 ? lines.length : until;
  let last = block;
  for (let index = block + 1; index < end; index += 1) {
    const found = keyLine(lines[index].body, key);
    if (found === null) {
      if (KEY_ANY.test(lines[index].body)) last = index;
      continue;
    }
    const replaced = replaceValue(lines[index].body, found.equal, literal);
    if (replaced === null) throw new KernelError('config_edit_shape_unsupported', { detail: 'that value is not one line' });
    lines[index].body = replaced;
    return { text: joined(lines), created: false };
  }
  // 补在这一张表已有那些键的后面：表头紧跟着一行注释时，那一行注释不该被插到中间去。
  lines.splice(last + 1, 0, { body: `${key} = ${literal}`, eol });
  return { text: joined(lines), created: true };
}

function appendTable(lines: Line[], eol: string, table: string, key: string, literal: string): { text: string; created: boolean } {
  const last = lines.at(-1)!;
  const base = last.body === '' && last.eol === '' ? lines.slice(0, -1) : lines;
  const added = base.length === 0 ? [] : [{ body: '', eol }];
  return {
    text: joined([...base, ...added, { body: `[${table}]`, eol }, { body: `${key} = ${literal}`, eol }]),
    created: true,
  };
}

/** 一份文件内容的版本：界面上读回来带着它，写的时候原样交回来核对。 */
export function configVersion(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function readConfigVersion(file: string): Promise<string> {
  try {
    return configVersion((await readFile(resolve(file))).toString('utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new KernelRuntimeError('config_file_read_failed', { cause: error, detail: file });
  }
}

/** 一次写入：锁住这一份文件，核对版本、换那一个值、整份读回来核对、先写临时文件再改名。 */
export async function writeConfigField(file: string, field: unknown, value: unknown, version: unknown): Promise<{ version: string; created: boolean }> {
  const definition = editableField(field);
  if (typeof version !== 'string') throw new KernelError('config_field_value', { detail: 'the version read from that file is required' });
  const { literal, value: wanted } = encodeValue(definition, value);
  const target = resolve(file);
  let release: () => Promise<void>;
  try {
    await mkdir(dirname(target), { recursive: true });
    release = await lockfile.lock(target, { realpath: false, lockfilePath: `${target}.lock`, stale: 10_000, update: 2_000, retries: 0 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ELOCKED') throw new KernelError('config_locked', { detail: `${target} has an active writer` });
    throw new KernelRuntimeError('config_lock_failed', { cause, detail: target });
  }
  try {
    let current = '';
    let exists = true;
    let mode: number | undefined;
    try {
      const bytes = await readFile(target);
      current = bytes.toString('utf8');
      mode = (await stat(target)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new KernelRuntimeError('config_file_read_failed', { cause: error, detail: target });
      }
      exists = false;
    }
    // 版本比对与替换在同一次持锁里做：先比对、再无保护地覆盖，等于把另一进程刚写的那一份丢掉。
    // 那份文件不在时版本是空串——它与「有一份但是空的」不是同一件事，后者交回的是空文本的哈希。
    if ((exists ? configVersion(current) : '') !== version) {
      throw new KernelError('config_version_stale', { detail: `${target} changed since it was read; nothing was written` });
    }
    const edited = editTomlValue(current, definition.path, literal);
    let parsed: Record<string, unknown>;
    try {
      parsed = parse(edited.text);
    } catch (cause) {
      throw new KernelError('config_edit_verify_failed', { cause, detail: 'the edited text does not read back as TOML' });
    }
    const landed = definition.path.reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], parsed);
    if (landed !== wanted) {
      throw new KernelError('config_edit_verify_failed', { detail: `${definition.path.join('.')} reads back as ${JSON.stringify(landed)}` });
    }
    const temporary = `${target}.tmp`;
    await writeFile(temporary, edited.text, 'utf8');
    await rename(temporary, target);
    // 新写的那一份按只有本人可读写；已经有那一份保住它自己的模式。Windows 上这一层由目录的继承规则管，chmod 只动到只读位。
    await chmod(target, mode ?? 0o600);
    return { version: configVersion(edited.text), created: edited.created };
  } finally {
    try {
      await release();
    } catch (cause) {
      throw new KernelRuntimeError('config_unlock_failed', { cause, detail: target });
    }
  }
}
