// 配置文件的写入侧（方案 7.2）：只换白名单里那几个标量字段的那一个值，其余字节一个不动。
// 为什么不用格式编辑库：本仓库装的 `smol-toml` 交回的是值而不是文档，整份重写会把注释、键的顺序与换行丢掉，
// 而这三样正是要保住的东西。这一条在原文里定位那一个值的跨度，只换它，行尾的注释留在原地；
// 换完整份读回来核对目标键等于要写的值，对不上就不落盘。
// 认的形状是「[表] 头之下的一条 `键 = 值`」、「顶层那一条 `表.键 = 值`」，以及数组表 `[[policy.rules]]` 的整块增删改。
// 多行字符串、内联表与嵌套表仍不认，撞上就报 `config_edit_shape_unsupported` 且一个字都不写。
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
  // 那张表只以数组表（`[[policy.rules]]`）的形式存在时，补的标量要落在那几段之前：
  // 先 `[[a.b]]` 再声明 `[a]` 不是合法形状，而且读的人也会以为这一行属于下面那一段。
  const anchor = arrayAnchorOf(lines, table);
  if (anchor !== -1) {
    lines.splice(anchor, 0, { body: `[${table}]`, eol }, { body: `${key} = ${literal}`, eol }, { body: '', eol });
    return { text: joined(lines), created: true };
  }
  const last = lines.at(-1)!;
  const base = last.body === '' && last.eol === '' ? lines.slice(0, -1) : lines;
  const added = base.length === 0 ? [] : [{ body: '', eol }];
  return {
    text: joined([...base, ...added, { body: `[${table}]`, eol }, { body: `${key} = ${literal}`, eol }]),
    created: true,
  };
}

// 那一张表的第一段数组表从哪里开始：贴着它头上那几行注释一起算作那一段的，不插到注释中间去。
function arrayAnchorOf(lines: Line[], table: string): number {
  const header = new RegExp(`^[ \\t]*\\[\\[\\s*${table}\\.[^\\]]*\\]\\]`);
  const index = lines.findIndex((line) => header.test(line.body));
  if (index === -1) return -1;
  let from = index;
  while (from > 0 && lines[from - 1].body.trimStart().startsWith('#')) from -= 1;
  return from;
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

/** 一份文件里写着的那张规则表：界面上的第几条指的是这一份，不是折完那一份。 */
export async function readConfigRules(file: string): Promise<PolicyRule[]> {
  try {
    return rulesOfLayer(parse((await readFile(resolve(file))).toString('utf8')) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
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

const isRulesHeader = (body: string): boolean => /^[ \t]*\[\[\s*policy\.rules\s*\]\][ \t]*(#.*)?$/.test(body);

function ruleName(body: string): string | null {
  const match = /^[ \t]*([^ \t=#]+)[ \t]*=/.exec(body);
  return match?.[1] ?? null;
}

// 一条数组表项占的行范围：从它的头到下一个任何表头之前，文件末尾也算一个边界。
function ruleBlocks(lines: Line[]): { start: number; end: number }[] {
  const blocks: { start: number; end: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isRulesHeader(lines[index].body)) continue;
    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (headerOf(lines[next].body) !== null) {
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
  const added: Line[] = [{ body: '[[policy.rules]]', eol }];
  for (const key of RULE_FIELDS) {
    const value = rule[key];
    if (value !== undefined) added.push({ body: `${key} = ${JSON.stringify(value)}`, eol });
  }
  return added;
}

// 注释说的是它下面那一段：追加要落在贴着下一个表头的注释之前，删除要把贴着自己头上的注释一起带走。
function unattachedEnd(lines: Line[], block: { start: number; end: number }): number {
  let end = block.end;
  while (end > block.start + 1 && lines[end - 1].body.trimStart().startsWith('#')) end -= 1;
  return end;
}

function attachedComment(lines: Line[], start: number): number {
  let from = start;
  while (from > 0 && lines[from - 1].body.trimStart().startsWith('#')) from -= 1;
  return from;
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
      lines.push({ body: '', eol }, ...added);
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
    lines.splice(from, block.end - from);
    return { text: joined(lines), created: false };
  }
  const wanted = rule as PolicyRule;
  const seen = new Set<string>();
  const kept: Line[] = [];
  for (let cursor = block.start + 1; cursor < block.end; cursor += 1) {
    const line = lines[cursor];
    const name = ruleName(line.body);
    if (name === null || !(RULE_FIELDS as readonly string[]).includes(name)) {
      kept.push(line);
      continue;
    }
    seen.add(name);
    const value = (wanted as Record<string, string | undefined>)[name];
    // 新规则里没有了的那一格（`match` 与 `reason` 都可以空着）删掉这一行，留着会读成旧值。
    if (value === undefined) continue;
    const found = keyLine(line.body, name);
    if (found === null) {
      kept.push(line);
      continue;
    }
    const replaced = replaceValue(line.body, found.equal, JSON.stringify(value));
    if (replaced === null) throw new KernelError('config_edit_shape_unsupported', { detail: `${name} is not one line` });
    kept.push({ body: replaced, eol: line.eol });
  }
  const toAdd = RULE_FIELDS.filter((key) => wanted[key] !== undefined && !seen.has(key))
    .map((key) => ({ body: `${key} = ${JSON.stringify(wanted[key])}`, eol }));
  const after = kept.map((line) => KEY_ANY.test(line.body)).lastIndexOf(true);
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
