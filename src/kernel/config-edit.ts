// 配置文件的写入侧（方案 7.2）：只换白名单里那几个标量字段的那一个值，其余字节一个不动。
// 为什么不用格式编辑库：本仓库装的 `smol-toml` 交回的是值而不是文档，整份重写会把注释、键的顺序与换行丢掉，
// 而这三样正是要保住的东西。这一条在原文里定位那一个值的跨度，只换它，行尾的注释留在原地；
// 换完整份读回来核对目标键等于要写的值，对不上就不落盘。
// 认的形状是「[表] 头之下的一条 `键 = 值`」、「顶层那一条 `表.键 = 值`」，以及数组表 `[[policy.rules]]` 的整块增删改。
// 键名与表名两侧的空白、带引号的写法都按 TOML 允许的形状认下来；多行字符串的那几行正文不当成键行或表头。
// 要换的那一个值是数组、内联表或多行字符串时，报 `config_edit_shape_unsupported` 并说出是哪一种形状，一个字都不写。
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse } from 'smol-toml';
import lockfile from 'proper-lockfile';
import { KernelError, KernelRuntimeError } from './error.js';

/** 一条工具规则：判定链里 `[[policy.rules]]` 的那一项。 */
export type PolicyRule = { tool: string; match?: string; decision: 'allow' | 'deny'; reason?: string };

/** 一次写入的请求：标量字段带 `value`，规则表带 `op` 与 `rule`（`update`、`remove` 还要 `index`）。 */
export type WriteRequest = {
  field: string;
  version: string;
  value?: unknown;
  op?: unknown;
  index?: unknown;
  rule?: unknown;
};

/** 一个可写字段：落在哪一条路径、值按什么形状收。 */
export type EditableField = {
  readonly path: readonly [string, string];
  readonly kind: 'string' | 'enum' | 'url' | 'envName' | 'rules';
  readonly oneOf?: readonly string[];
};

// 白名单由宿主持有：客户端说不出这一个键之外的事，也指不出一个文件路径（方案 7.2）。
export const EDITABLE: Readonly<Record<string, EditableField>> = {
  'model.api': { path: ['model', 'api'], kind: 'enum', oneOf: ['messages', 'chat-completions'] },
  'model.model': { path: ['model', 'model'], kind: 'string' },
  'model.baseURL': { path: ['model', 'baseURL'], kind: 'url' },
  'model.apiKeyEnv': { path: ['model', 'apiKeyEnv'], kind: 'envName' },
  'policy.mode': { path: ['policy', 'mode'], kind: 'enum', oneOf: ['ask', 'auto'] },
  'policy.rules': { path: ['policy', 'rules'], kind: 'rules' },
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

// hidden：这一行还是一段多行字符串的正文。pending：这一行读完时那一段还没有闭下来，下一行仍在正文里。
type Line = { body: string; eol: string; hidden: boolean; pending: boolean };

const makeLine = (body: string, eol: string): Line => ({ body, eol, hidden: false, pending: false });

// 按行切开且把每一行的换行形状记下来：混着 CRLF 与 LF 的那一份文件接回去还是原来那一份。
function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const next = text.indexOf('\n', start);
    if (next === -1) {
      lines.push(makeLine(text.endsWith('\r') ? text.slice(start, -1) : text.slice(start), ''));
      return markRegions(lines);
    }
    const crlf = text[next - 1] === '\r';
    lines.push(makeLine(text.slice(start, crlf ? next - 1 : next), crlf ? '\r\n' : '\n'));
    start = next + 1;
  }
}

// 标出一段多行字符串（`"""` 或 `'''`）正文占的那些行：那几行里看着像键行、表头与注释的东西都还只是正文。
// 一行之内已经闭上的普通串整段跳过，所以里面的三引号形状不会被当成一段的开头。
// 不认的只有「值以引号收尾」那一种写法（`about = """"x""""`）：四连引数在这里只算一段的结束加一次重新开始。
// 认错了的走向是拒写而不是写错——版本比对、读回核对与落盘在同一次持锁里兜着（见 writeConfigField）。上限：换成完整的字符串词法。
function markRegions(lines: Line[]): Line[] {
  let open: string | null = null;
  for (const line of lines) {
    const body = line.body;
    line.hidden = open !== null;
    let at = 0;
    while (at < body.length) {
      if (open !== null) {
        if (open === '"""' && body[at] === '\\') {
          at += 2;
          continue;
        }
        if (body.startsWith(open, at)) {
          at += 3;
          open = null;
          continue;
        }
        at += 1;
        continue;
      }
      const char = body[at];
      if (char === '#') break;
      if (body.startsWith('"""', at) || body.startsWith("'''", at)) {
        open = body.slice(at, at + 3);
        at += 3;
        continue;
      }
      at = char === '"' || char === "'" ? closeQuote(body, at) : at + 1;
    }
    line.pending = open !== null;
  }
  return lines;
}

// 本行里那一根引号的另一头：基本串按反斜杠转义，字面串里反斜杠不算。整行都找不到就走到行尾（那一份文件读不回 TOML）。
function closeQuote(body: string, from: number): number {
  const quote = body[from];
  for (let at = from + 1; at < body.length; at += 1) {
    if (quote === '"' && body[at] === '\\') at += 1;
    else if (body[at] === quote) return at + 1;
  }
  return body.length;
}

const joined = (lines: Line[]): string => lines.map((line) => line.body + line.eol).join('');

// 一段键名：裸键（TOML 的裸键不含点号）、基本串键、字面串键。基本串里带反斜杠的那种认不下来，
// 那一行不当成键行，要写的值补成一条重复键，读回核对处拒掉。
const KEY_SEGMENT = String.raw`[A-Za-z0-9_-]+|"[^"\\]*"|'[^']*'`;
const SEGMENT_START = new RegExp(`^(${KEY_SEGMENT})`);
const PATH_START = new RegExp(`^[ \\t]*((?:${KEY_SEGMENT})(?:[ \\t]*\\.[ \\t]*(?:${KEY_SEGMENT}))*)[ \\t]*`);
const SEPARATOR = /^[ \t]*\.[ \t]*/;

const unquote = (text: string): string => (text[0] === '"' || text[0] === "'" ? text.slice(1, -1) : text);

// 点号把几段连成一条路径；引号里的点号属于那一段键名，不是分隔。
function splitKeyParts(text: string): string[] | null {
  const parts: string[] = [];
  let at = 0;
  for (;;) {
    const match = SEGMENT_START.exec(text.slice(at));
    if (match === null) return null;
    parts.push(unquote(match[1]));
    at += match[1].length;
    const rest = text.slice(at);
    if (rest === '') return parts;
    const separator = SEPARATOR.exec(rest);
    if (separator === null) return null;
    at += separator[0].length;
  }
}

/** 一行表头：`[[数组表]]` 交回空串（它永远不等于一个表名，但会切断上面那一段），`[表]` 交回那张表的名字。 */
function headerOf(line: Line): string | null {
  if (line.hidden) return null;
  if (/^[ \t]*\[\[/.test(line.body)) return '';
  const match = /^[ \t]*\[([^[\]]*)\][ \t]*(#.*)?$/.exec(line.body);
  if (match === null) return null;
  const parts = splitKeyParts(match[1].trim());
  return parts === null ? null : parts.join('.');
}

/** 一段数组表头那张数组表的名字：`[[policy.rules]]` 交回 `policy.rules`，别的形状交回 null。 */
function arrayHeaderOf(line: Line): string | null {
  if (line.hidden) return null;
  const match = /^[ \t]*\[\[([^\]]*)\]\][ \t]*(#.*)?$/.exec(line.body);
  if (match === null) return null;
  const parts = splitKeyParts(match[1].trim());
  return parts === null ? null : parts.join('.');
}

const isComment = (line: Line): boolean => !line.hidden && line.body.trimStart().startsWith('#');

/** 一行键值：交回那条键的路径与等号的位置。表头、注释、多行字符串的那几行正文与没有等号的行都交回 null。 */
function keyOf(line: Line): { parts: string[]; equal: number } | null {
  if (line.hidden || isComment(line)) return null;
  const match = PATH_START.exec(line.body);
  if (match === null || line.body[match[0].length] !== '=') return null;
  const parts = splitKeyParts(match[1]);
  return parts === null ? null : { parts, equal: match[0].length };
}

const samePath = (parts: readonly string[], wanted: readonly string[]): boolean =>
  parts.length === wanted.length && wanted.every((part, index) => parts[index] === part);

// 等号右边那一段：跨度到注释或行尾为止，两者本身都不含在内。数组、内联表、没在本行闭上的引号都认不下来。
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
  // 等号后那些空白是原文件自己的形状：合同只换那一个值，所以这一段原样留着（方案 7.2）。
  return `${body.slice(0, after)}${literal}${body.slice(end)}`;
}

// 换不了的那一个值说出它是什么形状：这一条路只换得上本行闭得下来的那一个值。
function refuseShape(body: string, equal: number, path: readonly string[]): never {
  let at = equal + 1;
  while (body[at] === ' ' || body[at] === '\t') at += 1;
  const shape =
    body.startsWith('"""', at) || body.startsWith("'''", at)
      ? 'a multi-line string'
      : body[at] === '['
        ? 'an array'
        : body[at] === '{'
          ? 'an inline table'
          : 'a value that does not close on this line';
  throw new KernelError('config_edit_shape_unsupported', {
    detail: `${path.join('.')} holds ${shape}; only a value that closes on its own line can be changed`,
  });
}

/** 在原文里换掉那一个值：注释、其余键、键的顺序与每一行的换行形状都留着。键不存在时在那一张表里补一行。 */
export function editTomlValue(text: string, path: readonly [string, string], literal: string): { text: string; created: boolean } {
  const [table, key] = path;
  const lines = splitLines(text);
  const eol = lines.find((line) => line.eol !== '')?.eol ?? '\n';
  const first = lines.findIndex((line) => headerOf(line) !== null);
  // 顶层那一段（第一张表的头之前）写的 `表.键 = 值` 与表里那一条是同一件事。
  const scope = first === -1 ? lines.length : first;
  for (let index = 0; index < scope; index += 1) {
    const found = keyOf(lines[index]);
    if (found === null || !samePath(found.parts, [table, key])) continue;
    const replaced = replaceValue(lines[index].body, found.equal, literal);
    if (replaced === null) refuseShape(lines[index].body, found.equal, [table, key]);
    lines[index].body = replaced;
    return { text: joined(lines), created: false };
  }
  if (first === -1) {
    return appendTable(lines, eol, table, key, literal);
  }
  const block = lines.findIndex((line, index) => index >= first && headerOf(line) === table);
  if (block === -1) {
    return appendTable(lines, eol, table, key, literal);
  }
  const until = lines.findIndex((line, index) => index > block && headerOf(line) !== null);
  const end = until === -1 ? lines.length : until;
  let last = block;
  for (let index = block + 1; index < end; index += 1) {
    const found = keyOf(lines[index]);
    if (found === null) continue;
    if (!samePath(found.parts, [key])) {
      // 那一行把一段多行字符串打开了就还没写完：补的行落在它后面会掉进正文里，所以锚点只认已经写完的那一行。
      if (!lines[index].pending) last = index;
      continue;
    }
    const replaced = replaceValue(lines[index].body, found.equal, literal);
    if (replaced === null) refuseShape(lines[index].body, found.equal, [table, key]);
    lines[index].body = replaced;
    return { text: joined(lines), created: false };
  }
  // 补在这一张表已有那些键的后面：表头紧跟着一行注释时，那一行注释不该被插到中间去。
  lines.splice(last + 1, 0, makeLine(`${key} = ${literal}`, eol));
  return { text: joined(lines), created: true };
}

function appendTable(lines: Line[], eol: string, table: string, key: string, literal: string): { text: string; created: boolean } {
  // 那张表只以数组表（`[[policy.rules]]`）的形式存在时，补的标量要落在那几段之前：
  // 先 `[[a.b]]` 再声明 `[a]` 不是合法形状，而且读的人也会以为这一行属于下面那一段。
  const anchor = arrayAnchorOf(lines, table);
  if (anchor !== -1) {
    lines.splice(anchor, 0, makeLine(`[${table}]`, eol), makeLine(`${key} = ${literal}`, eol), makeLine('', eol));
    return { text: joined(lines), created: true };
  }
  const last = lines.at(-1)!;
  const base = last.body === '' && last.eol === '' ? lines.slice(0, -1) : lines;
  const added = base.length === 0 ? [] : [makeLine('', eol)];
  return {
    text: joined([...base, ...added, makeLine(`[${table}]`, eol), makeLine(`${key} = ${literal}`, eol)]),
    created: true,
  };
}

// 那一张表的第一段数组表从哪里开始：贴着它头上那几行注释一起算作那一段的，不插到注释中间去。
function arrayAnchorOf(lines: Line[], table: string): number {
  const index = lines.findIndex((line) => arrayHeaderOf(line)?.startsWith(`${table}.`) === true);
  if (index === -1) return -1;
  let from = index;
  while (from > 0 && isComment(lines[from - 1])) from -= 1;
  return from;
}

/** 一份文件内容的版本：界面上读回来带着它，写的时候原样交回来核对。 */
export function configVersion(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 一份设置文件读一遍：版本与解析出来的那张表出自同一次读（方案 3A）。文件不在时版本是空串、表是空的。 */
export async function readConfigLayer(file: string): Promise<{ version: string; table: Record<string, unknown> }> {
  let text: string;
  try {
    text = (await readFile(resolve(file))).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: '', table: {} };
    throw new KernelRuntimeError('config_file_read_failed', { cause: error, detail: file });
  }
  try {
    return { version: configVersion(text), table: parse(text) as Record<string, unknown> };
  } catch (error) {
    throw new KernelRuntimeError('config_file_read_failed', { cause: error, detail: file });
  }
}

/** 一次写入：锁住这一份文件，核对版本、做那一次动作、整份读回来核对、先写临时文件再改名。 */
export async function writeConfigField(
  file: string,
  request: WriteRequest,
): Promise<{ version: string; created: boolean; rules?: PolicyRule[] }> {
  const definition = editableField(request.field);
  if (typeof request.version !== 'string') throw new KernelError('config_field_value', { detail: 'the version read from that file is required' });
  const scalar = definition.kind === 'rules' ? undefined : encodeValue(definition, request.value);
  const op = definition.kind === 'rules' ? checkedOp(request.op) : undefined;
  const index = definition.kind === 'rules' ? checkedIndex(request.index) : 0;
  const rule = definition.kind === 'rules' && op !== 'remove' ? checkedRule(request.rule) : undefined;
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
    if ((exists ? configVersion(current) : '') !== request.version) {
      throw new KernelError('config_version_stale', { detail: `${target} changed since it was read; nothing was written` });
    }
    const read = (text: string, code: 'config_file_invalid' | 'config_edit_verify_failed'): Record<string, unknown> => {
      try {
        return parse(text) as Record<string, unknown>;
      } catch (cause) {
        throw new KernelError(code, { cause, detail: `${code === 'config_file_invalid' ? 'that file' : 'the edited text'} does not read back as TOML` });
      }
    };
    const before = definition.kind === 'rules' ? rulesOfLayer(read(current, 'config_file_invalid')) : [];
    const edited = scalar === undefined
      ? editRuleTable(current, op as RuleOp, index, rule)
      : editTomlValue(current, definition.path, scalar.literal);
    const parsed = read(edited.text, 'config_edit_verify_failed');
    if (scalar === undefined) {
      // 核对的是整张表：别的项被这一趟动过，也要在这里说出来。
      const landed = digestRules(rulesOfLayer(parsed));
      const wanted = digestRules(expectedRules(before, op as RuleOp, index, rule));
      if (landed !== wanted) {
        throw new KernelError('config_edit_verify_failed', { detail: `policy.rules reads back as ${landed}` });
      }
    } else {
      const landed = definition.path.reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], parsed);
      if (landed !== scalar.value) {
        throw new KernelError('config_edit_verify_failed', { detail: `${definition.path.join('.')} reads back as ${JSON.stringify(landed)}` });
      }
    }
    const temporary = `${target}.tmp`;
    await writeFile(temporary, edited.text, 'utf8');
    await rename(temporary, target);
    // 新写的那一份按只有本人可读写；已经有那一份保住它自己的模式。Windows 上这一层由目录的继承规则管，chmod 只动到只读位。
    await chmod(target, mode ?? 0o600);
    return {
      version: configVersion(edited.text),
      created: edited.created,
      ...(scalar === undefined ? { rules: expectedRules(before, op as RuleOp, index, rule) } : {}),
    };
  } finally {
    try {
      await release();
    } catch (cause) {
      throw new KernelRuntimeError('config_unlock_failed', { cause, detail: target });
    }
  }
}

// ---- 工具规则表：`[[policy.rules]]` 的整块增删改（D100）----

const RULE_FIELDS = ['tool', 'match', 'decision', 'reason'] as const;
const RULE_OPS = ['add', 'update', 'remove'] as const;
type RuleOp = (typeof RULE_OPS)[number];

function checkedOp(op: unknown): RuleOp {
  if (typeof op !== 'string' || !(RULE_OPS as readonly string[]).includes(op)) {
    throw new KernelError('config_rule_invalid', { detail: `op takes one of: ${RULE_OPS.join(', ')}` });
  }
  return op as RuleOp;
}

function checkedIndex(index: unknown): number {
  if (index === undefined) return 0;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw new KernelError('config_rule_invalid', { detail: 'index takes a whole rule position starting at 0' });
  }
  return index;
}

/** 规则的形状由宿主持有：认不下的键、空的值与非法的动作都不写进文件。 */
export function checkedRule(input: unknown): PolicyRule {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new KernelError('config_rule_invalid', { detail: `a rule is an object of: ${RULE_FIELDS.join(', ')}` });
  }
  const given = input as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!(RULE_FIELDS as readonly string[]).includes(key)) {
      throw new KernelError('config_rule_invalid', { detail: `${key} is not one of: ${RULE_FIELDS.join(', ')}` });
    }
  }
  const text = (key: string): string | undefined => {
    const value = given[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new KernelError('config_rule_invalid', { detail: `${key} takes a non-empty string` });
    }
    return value.trim();
  };
  const tool = text('tool');
  const decision = text('decision');
  if (tool === undefined) throw new KernelError('config_rule_invalid', { detail: 'tool is required' });
  if (decision !== 'allow' && decision !== 'deny') {
    throw new KernelError('config_rule_invalid', { detail: 'decision takes allow or deny' });
  }
  const match = text('match');
  const reason = text('reason');
  return {
    tool,
    decision,
    ...(match === undefined ? {} : { match }),
    ...(reason === undefined ? {} : { reason }),
  };
}

const isRulesHeader = (line: Line): boolean => arrayHeaderOf(line) === 'policy.rules';

// 一条数组表项占的行范围：从它的头到下一个任何表头之前，文件末尾也算一个边界。
function ruleBlocks(lines: Line[]): { start: number; end: number }[] {
  const blocks: { start: number; end: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isRulesHeader(lines[index])) continue;
    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (headerOf(lines[next]) !== null) {
        end = next;
        break;
      }
    }
    blocks.push({ start: index, end });
    index = end - 1;
  }
  return blocks;
}

function ruleLines(rule: PolicyRule, eol: string): Line[] {
  const added: Line[] = [makeLine('[[policy.rules]]', eol)];
  for (const key of RULE_FIELDS) {
    const value = rule[key];
    if (value !== undefined) added.push(makeLine(`${key} = ${JSON.stringify(value)}`, eol));
  }
  return added;
}

// 注释说的是它下面那一段：追加要落在贴着下一个表头的注释之前，删除要把贴着自己头上的注释一起带走。
function unattachedEnd(lines: Line[], block: { start: number; end: number }): number {
  let end = block.end;
  while (end > block.start + 1 && isComment(lines[end - 1])) end -= 1;
  return end;
}

function attachedComment(lines: Line[], start: number): number {
  let from = start;
  while (from > 0 && isComment(lines[from - 1])) from -= 1;
  return from;
}

// 一条语句占的那几行：本行打开一段多行字符串且没在本行闭下来时，那几行正文与闭上的那一行都跟着它一起算。
function spanEndOf(lines: Line[], from: number, limit: number): number {
  if (!lines[from].pending) return from + 1;
  const closing = lines.findIndex((line, index) => index > from && index < limit && line.hidden && !line.pending);
  return closing === -1 ? limit : closing + 1;
}

/** 在原文里对规则表做一次动作：新增一项、换掉那一项里的键、删掉那一项。表之外的字节一个不动。 */
export function editRuleTable(text: string, op: RuleOp, index: number, rule?: PolicyRule): { text: string; created: boolean } {
  const lines = splitLines(text);
  const eol = lines.find((line) => line.eol !== '')?.eol ?? '\n';
  const blocks = ruleBlocks(lines);
  if (op === 'add') {
    const last = blocks.at(-1);
    const added = ruleLines(rule as PolicyRule, eol);
    if (last === undefined) {
      if (text.trim() === '') return { text: joined(added), created: true };
      lines.at(-1)!.eol = eol;
      lines.push(makeLine('', eol), ...added);
      return { text: joined(lines), created: true };
    }
    lines.at(-1)!.eol = eol;
    lines.splice(unattachedEnd(lines, last), 0, ...added);
    return { text: joined(lines), created: false };
  }
  const block = blocks[index];
  if (block === undefined) {
    throw new KernelError('config_rule_index', { detail: `that file has ${blocks.length} rules, so rule ${index} is not one of them` });
  }
  if (op === 'remove') {
    const from = attachedComment(lines, block.start);
    // 收的范围到 `unattachedEnd` 为止：贴着下一个表头的那几行注释说的是下一条规则，不在这条规则的块里。
    lines.splice(from, unattachedEnd(lines, block) - from);
    return { text: joined(lines), created: false };
  }
  const wanted = rule as PolicyRule;
  const seen = new Set<string>();
  const kept: Line[] = [];
  for (let cursor = block.start + 1; cursor < block.end; cursor += 1) {
    const line = lines[cursor];
    const until = spanEndOf(lines, cursor, block.end);
    const found = keyOf(line);
    if (found === null || found.parts.length !== 1 || !(RULE_FIELDS as readonly string[]).includes(found.parts[0])) {
      kept.push(...lines.slice(cursor, until));
      cursor = until - 1;
      continue;
    }
    const name = found.parts[0];
    seen.add(name);
    const value = (wanted as Record<string, string | undefined>)[name];
    // 新规则里没有了的那一格（`match` 与 `reason` 都可以空着）整条语句删掉，只删头一行会把正文丢在原地。
    if (value === undefined) {
      cursor = until - 1;
      continue;
    }
    const replaced = replaceValue(line.body, found.equal, JSON.stringify(value));
    if (replaced === null) refuseShape(line.body, found.equal, [name]);
    kept.push(makeLine(replaced, line.eol));
    cursor = until - 1;
  }
  const toAdd = RULE_FIELDS.filter((key) => wanted[key] !== undefined && !seen.has(key))
    .map((key) => makeLine(`${key} = ${JSON.stringify(wanted[key])}`, eol));
  // 落在这一项已有那些键的后面：一段还没写完的多行字符串那一行不算锚点，补进去会掉进它的正文里。
  const after = kept.map((line) => keyOf(line) !== null && !line.pending).lastIndexOf(true);
  kept.splice(after === -1 ? kept.length : after + 1, 0, ...toAdd);
  lines.splice(block.start + 1, block.end - block.start - 1, ...kept);
  return { text: joined(lines), created: false };
}

/** 交回一张表里读出来的那些项：认不下的形状报出来，不静默少一项。 */
export function rulesOfLayer(parsed: Record<string, unknown>): PolicyRule[] {
  const policy = parsed.policy;
  if (policy === undefined) return [];
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new KernelError('config_edit_shape_unsupported', { detail: '[policy] is not a table' });
  }
  const rules = (policy as Record<string, unknown>).rules;
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) throw new KernelError('config_edit_shape_unsupported', { detail: 'policy.rules is not a table array' });
  return rules.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new KernelError('config_edit_shape_unsupported', { detail: 'a rule is not a table' });
    }
    const given = item as Record<string, unknown>;
    const only = (key: (typeof RULE_FIELDS)[number]): Record<string, string> => {
      const value = given[key];
      return typeof value === 'string' && value !== '' ? { [key]: value } : {};
    };
    return { ...only('tool'), ...only('match'), ...only('decision'), ...only('reason') } as PolicyRule;
  });
}

/** 按同一次动作算出读回来该长成什么样。 */
export function expectedRules(current: PolicyRule[], op: RuleOp, index: number, rule?: PolicyRule): PolicyRule[] {
  const list = current.map((item) => ({ ...item }));
  if (op === 'add') list.push({ ...(rule as PolicyRule) });
  else if (op === 'remove') list.splice(index, 1);
  else {
    const target: Record<string, unknown> = { ...list[index] };
    for (const key of RULE_FIELDS) {
      const value = (rule as PolicyRule)[key];
      if (value === undefined) delete target[key];
      else target[key] = value;
    }
    list[index] = target as unknown as PolicyRule;
  }
  return list;
}

// 核对用的写法：键的顺序在这里定下来，两边同一个函数，文件里多写的未知键不参与比较。
export function digestRules(list: PolicyRule[]): string {
  return list
    .map((rule) => RULE_FIELDS.map((key) => `${key}=${JSON.stringify(rule[key] ?? '')}`).join(' '))
    .join('\n');
}
