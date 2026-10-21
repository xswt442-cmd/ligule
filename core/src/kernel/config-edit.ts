// TOML 解析器提供语法节点和文本范围；编辑器只修改允许字段和规则表。
// 写入前校验文件版本和完整配置，同时保留其他注释、键顺序和原始字节。
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { getStaticTOMLValue, parseTOML, traverseNodes, VisitorKeys, type AST } from 'toml-eslint-parser';
import lockfile from 'proper-lockfile';
import { isDeepStrictEqual } from 'node:util';
import { KernelError, KernelRuntimeError } from './error.js';
import { modelSelection, modelServices, selectionLiteral, servicesLiteral } from './model-services.js';

/** `[[policy.rules]]` 中的一条工具规则。 */
export type PolicyRule = { tool: string; match?: string; decision: 'allow' | 'ask' | 'deny'; reason?: string };

/** 配置写入请求：标量字段使用 `value`，规则表使用 `op` 和 `rule`；更新或删除还需提供 `index`。 */
export type WriteRequest = {
  field: string;
  version: string;
  value?: unknown;
  op?: unknown;
  index?: unknown;
  rule?: unknown;
};

/** 可写配置字段及其文件路径和允许的值类型。 */
export type EditableField = {
  readonly path: readonly [string, string];
  readonly kind: 'string' | 'enum' | 'url' | 'envName' | 'rules' | 'services' | 'selection' | 'positiveInteger';
  readonly oneOf?: readonly string[];
};

// Host 维护可写字段白名单；客户端不能指定其他键或文件路径。
export const EDITABLE: Readonly<Record<string, EditableField>> = {
  'model.api': { path: ['model', 'api'], kind: 'enum', oneOf: ['messages', 'chat-completions'] },
  'model.model': { path: ['model', 'model'], kind: 'string' },
  'model.baseURL': { path: ['model', 'baseURL'], kind: 'url' },
  'model.apiKeyEnv': { path: ['model', 'apiKeyEnv'], kind: 'envName' },
  'model.services': { path: ['model', 'services'], kind: 'services' },
  'model.selection': { path: ['model', 'selection'], kind: 'selection' },
  'model.outputTokens': { path: ['model', 'outputTokens'], kind: 'positiveInteger' },
  'policy.mode': { path: ['policy', 'mode'], kind: 'enum', oneOf: ['ask', 'auto', 'never'] },
  'policy.rules': { path: ['policy', 'rules'], kind: 'rules' },
};

export function editableField(field: unknown): EditableField {
  if (typeof field !== 'string' || EDITABLE[field] === undefined) {
    throw new KernelError('config_field_unknown', { detail: `writable fields: ${Object.keys(EDITABLE).join(', ')}` });
  }
  return EDITABLE[field];
}

/** 校验字段值，并返回用于 TOML 写入和回读比较的表示。 */
export function encodeValue(field: EditableField, value: unknown): { literal: string; value: unknown } {
  if (field.kind === 'positiveInteger') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new KernelError('config_field_value', { detail: 'takes a positive safe integer' });
    }
    return { literal: String(value), value };
  }
  if (field.kind === 'services') {
    const services = modelServices(value);
    return { literal: servicesLiteral(services), value: services };
  }
  if (field.kind === 'selection') {
    const selection = modelSelection(value);
    return { literal: selectionLiteral(selection), value: selection };
  }
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
    // 凭据通过环境变量引用；不要将密钥写入 URL 或配置文件。
    if (url.username !== '' || url.password !== '') {
      throw new KernelError('config_field_value', { detail: 'credentials do not belong in the address' });
    }
  }
  if (field.kind === 'envName' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    throw new KernelError('config_field_value', { detail: 'takes one environment variable name, not its value' });
  }
  return { literal: JSON.stringify(text), value: text };
}

// 使用 AST 中的 TOML 结构和键路径，只替换原文中对应的跨度。
type ParsedPair = { node: AST.TOMLKeyValue; path: (string | number)[] };
type ParsedDocument = { root: AST.TOMLProgram; tables: AST.TOMLTable[]; pairs: ParsedPair[] };
type TextEdit = { start: number; end: number; text: string };

function parseDocument(text: string): ParsedDocument {
  let root: AST.TOMLProgram;
  try {
    root = parseTOML(text, { tomlVersion: '1.1.0' });
  } catch (cause) {
    throw new KernelError('config_file_invalid', { cause, detail: 'the TOML document cannot be read' });
  }
  const tables: AST.TOMLTable[] = [];
  const pairs: ParsedPair[] = [];
  traverseNodes(root, {
    visitorKeys: VisitorKeys,
    enterNode(node) {
      if (node.type === 'TOMLTable') tables.push(node);
      if (node.type !== 'TOMLKeyValue') return;
      const parent = node.parent;
      if (parent.type !== 'TOMLTable' && parent.type !== 'TOMLTopLevelTable') return;
      pairs.push({
        node,
        path: [...(parent.type === 'TOMLTable' ? parent.resolvedKey : []), ...getStaticTOMLValue(node.key)],
      });
    },
    leaveNode() {},
  });
  tables.sort((left, right) => left.range[0] - right.range[0]);
  pairs.sort((left, right) => left.node.range[0] - right.node.range[0]);
  return { root, tables, pairs };
}

const sameTomlPath = (left: readonly (string | number)[], right: readonly (string | number)[]): boolean =>
  left.length === right.length && left.every((part, index) => part === right[index]);

const startsWithTomlPath = (path: readonly (string | number)[], prefix: readonly (string | number)[]): boolean =>
  path.length >= prefix.length && prefix.every((part, index) => part === path[index]);

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

function lineEnd(text: string, offset: number): number {
  const next = text.indexOf('\n', Math.max(0, offset));
  return next === -1 ? text.length : next + 1;
}

function lineEndingAt(text: string, offset: number): string {
  const start = lineStart(text, Math.min(offset, text.length));
  const next = text.indexOf('\n', start);
  if (next !== -1) return text[next - 1] === '\r' ? '\r\n' : '\n';
  const previous = text.lastIndexOf('\n', Math.max(0, start - 1));
  return previous > 0 && text[previous - 1] === '\r' ? '\r\n' : '\n';
}

function standaloneComment(text: string, comment: AST.Comment): boolean {
  return comment.loc.start.line === comment.loc.end.line
    && text.slice(lineStart(text, comment.range[0]), comment.range[0]).trim() === '';
}

function leadingCommentStart(text: string, root: AST.TOMLProgram, table: AST.TOMLTable): number {
  let line = table.loc.start.line - 1;
  let start = lineStart(text, table.range[0]);
  while (line > 0) {
    const comment = root.comments.find((item) => item.loc.start.line === line && item.loc.end.line === line && standaloneComment(text, item));
    if (comment === undefined) break;
    start = lineStart(text, comment.range[0]);
    line -= 1;
  }
  return start;
}

function trailingCommentStart(text: string, root: AST.TOMLProgram): number | undefined {
  const comment = [...root.comments].reverse().find((item) =>
    standaloneComment(text, item) && text.slice(item.range[1]).trim() === '',
  );
  if (comment === undefined) return undefined;
  let line = comment.loc.start.line;
  let start = lineStart(text, comment.range[0]);
  for (;;) {
    const previous = root.comments.find((item) =>
      item.loc.start.line === line - 1 && item.loc.end.line === line - 1 && standaloneComment(text, item),
    );
    if (previous === undefined) return start;
    line -= 1;
    start = lineStart(text, previous.range[0]);
  }
}

function applyTextEdits(text: string, edits: TextEdit[]): string {
  const ordered = [...edits].sort((left, right) => right.start - left.start || right.end - left.end);
  let boundary = text.length + 1;
  let result = text;
  for (const edit of ordered) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > text.length || edit.end > boundary) {
      throw new KernelError('config_edit_verify_failed', { detail: 'TOML edit ranges overlap or exceed the document' });
    }
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
    boundary = edit.start;
  }
  return result;
}

function valueShape(value: AST.TOMLContentNode): string | undefined {
  if (value.type === 'TOMLArray') return 'an array';
  if (value.type === 'TOMLInlineTable') return 'an inline table';
  if (value.type === 'TOMLValue' && value.kind === 'string' && value.multiline) return 'a multi-line string';
  return undefined;
}

function changeTomlValue(pair: ParsedPair, literal: string): TextEdit {
  const shape = valueShape(pair.node.value);
  if (shape !== undefined) {
    throw new KernelError('config_edit_shape_unsupported', {
      detail: `${pair.path.join('.')} holds ${shape}; only a single scalar value can be changed`,
    });
  }
  return { start: pair.node.value.range[0], end: pair.node.value.range[1], text: literal };
}

function standardTable(tables: AST.TOMLTable[], path: readonly (string | number)[]): AST.TOMLTable | undefined {
  return tables.find((table) => table.kind === 'standard' && sameTomlPath(table.resolvedKey, path));
}

function appendTomlTable(text: string, table: string, key: string, literal: string): string {
  const eol = lineEndingAt(text, text.length);
  const prefix = text === ''
    ? ''
    : text.endsWith(`${eol}${eol}`) ? '' : text.endsWith(eol) ? eol : `${eol}${eol}`;
  return `${text}${prefix}[${table}]${eol}${key} = ${literal}${eol}`;
}

/** 在原文中替换指定值并保留其他字节；键不存在时在对应表中新增一行。 */
export function editTomlValue(text: string, path: readonly [string, string], literal: string, structured = false): { text: string; created: boolean } {
  const parsed = parseDocument(text);
  const existing = parsed.pairs.find((pair) => sameTomlPath(pair.path, path));
  if (existing !== undefined) {
    if (structured) {
      // 受管数组或表包含注释时拒绝整体替换，避免丢失手工编辑内容。
      if (parsed.root.comments.some((comment) => comment.range[0] > existing.node.value.range[0] && comment.range[1] < existing.node.value.range[1])) {
        throw new KernelError('config_edit_shape_unsupported', { detail: 'the managed value contains comments; edit this value in the config file' });
      }
      return { text: applyTextEdits(text, [{ start: existing.node.value.range[0], end: existing.node.value.range[1], text: literal }]), created: false };
    }
    return { text: applyTextEdits(text, [changeTomlValue(existing, literal)]), created: false };
  }

  const [tableName, key] = path;
  const table = standardTable(parsed.tables, [tableName]);
  if (table !== undefined) {
    const directPairs = parsed.pairs.filter((pair) =>
      pair.node.parent === table && pair.path.length === 2 && pair.path[0] === tableName,
    );
    const last = directPairs.filter((pair) => valueShape(pair.node.value) !== 'a multi-line string').at(-1);
    const anchor = last?.node.range[1] ?? table.key.range[0];
    const at = lineEnd(text, anchor);
    const eol = lineEndingAt(text, anchor);
    const prefix = at === text.length && !text.endsWith('\n') ? eol : '';
    return {
      text: applyTextEdits(text, [{ start: at, end: at, text: `${prefix}${key} = ${literal}${eol}` }]),
      created: true,
    };
  }

  const rootPairs = parsed.pairs.filter((pair) =>
    pair.node.parent.type === 'TOMLTopLevelTable'
      && pair.path.length > 1
      && pair.path[0] === tableName,
  );
  const rootPair = rootPairs.at(-1);
  if (rootPair !== undefined) {
    const anchor = rootPair.node.range[1];
    const at = lineEnd(text, anchor);
    const eol = lineEndingAt(text, anchor);
    const prefix = at === text.length && !text.endsWith('\n') ? eol : '';
    return {
      text: applyTextEdits(text, [{ start: at, end: at, text: `${prefix}${tableName}.${key} = ${literal}${eol}` }]),
      created: true,
    };
  }

  const descendant = parsed.tables.find((candidate) =>
    startsWithTomlPath(candidate.resolvedKey, [tableName]) && candidate.resolvedKey.length > 1,
  );
  if (descendant !== undefined) {
    const at = leadingCommentStart(text, parsed.root, descendant);
    const eol = lineEndingAt(text, descendant.range[0]);
    return {
      text: applyTextEdits(text, [{ start: at, end: at, text: `[${tableName}]${eol}${key} = ${literal}${eol}${eol}` }]),
      created: true,
    };
  }
  return { text: appendTomlTable(text, tableName, key, literal), created: true };
}

/** 文件内容版本；客户端写入时必须提交最近读取的版本。 */
export function configVersion(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 一次读取设置文件并返回对应版本；文件不存在时返回空版本和空表。 */
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

/** 锁定文件、校验版本、应用修改并回读验证，最后通过临时文件和重命名原子写入。 */
export async function writeConfigField(
  file: string,
  request: WriteRequest,
  validate?: (candidate: Record<string, unknown>) => void | Promise<void>,
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
  const temporary = `${target}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
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
    // 版本比较和写入都在同一文件锁内完成，避免覆盖其他进程的更新。
    // 文件不存在时使用空版本；已存在的空文件仍使用其内容哈希。
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
      : editTomlValue(current, definition.path, scalar.literal, definition.kind === 'services' || definition.kind === 'selection');
    const parsed = read(edited.text, 'config_edit_verify_failed');
    if (scalar === undefined) {
      // 比较整个规则表，检测写入期间其他规则是否发生变化。
      const landed = digestRules(rulesOfLayer(parsed));
      const wanted = digestRules(expectedRules(before, op as RuleOp, index, rule));
      if (landed !== wanted) {
        throw new KernelError('config_edit_verify_failed', { detail: `policy.rules reads back as ${landed}` });
      }
    } else {
      const landed = definition.path.reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], parsed);
      if (!isDeepStrictEqual(structuredClone(landed), structuredClone(scalar.value))) {
        throw new KernelError('config_edit_verify_failed', { detail: `${definition.path.join('.')} reads back as ${JSON.stringify(landed)}` });
      }
    }
    await validate?.(parsed);
    const handle = await open(temporary, 'wx', mode ?? 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(edited.text, 'utf8');
      await handle.chmod(mode ?? 0o600);
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    temporaryCreated = false;
    return {
      version: configVersion(edited.text),
      created: edited.created,
      ...(scalar === undefined ? { rules: expectedRules(before, op as RuleOp, index, rule) } : {}),
    };
  } finally {
    try {
      if (temporaryCreated) await rm(temporary, { force: true });
    } finally {
      try {
        await release();
      } catch (cause) {
        throw new KernelRuntimeError('config_unlock_failed', { cause, detail: target });
      }
    }
  }
}

// `[[policy.rules]]` 规则表的增删改。

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

/** 校验规则字段、非空值和动作类型；无效规则不得写入文件。 */
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
  if (decision !== 'allow' && decision !== 'ask' && decision !== 'deny') {
    throw new KernelError('config_rule_invalid', { detail: 'decision takes allow, ask, or deny' });
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

/** 在原文中添加、更新或删除一条规则，并保留规则表之外的字节。 */
const RULES_PATH = ['policy', 'rules'] as const;

function ruleTables(document: ParsedDocument): AST.TOMLTable[] {
  return document.tables.filter((table) =>
    table.kind === 'array'
      && table.resolvedKey.length === 3
      && sameTomlPath(table.resolvedKey.slice(0, 2), RULES_PATH)
      && typeof table.resolvedKey[2] === 'number',
  );
}

function ruleDescendants(document: ParsedDocument, rule: AST.TOMLTable): AST.TOMLTable[] {
  return document.tables.filter((table) => startsWithTomlPath(table.resolvedKey, rule.resolvedKey));
}

function ruleTableEdit(text: string, document: ParsedDocument, table: AST.TOMLTable): TextEdit {
  const next = document.tables.find((candidate) => candidate.range[0] >= table.range[1]);
  const end = next === undefined
    ? trailingCommentStart(text, document.root) ?? text.length
    : leadingCommentStart(text, document.root, next);
  return { start: leadingCommentStart(text, document.root, table), end, text: '' };
}

function ruleBlockText(rule: PolicyRule, eol: string): string {
  const rows = [`[[policy.rules]]`];
  for (const key of RULE_FIELDS) {
    const value = rule[key];
    if (value !== undefined) rows.push(`${key} = ${JSON.stringify(value)}`);
  }
  return `${rows.join(eol)}${eol}`;
}

export function editRuleTable(text: string, op: RuleOp, index: number, rule?: PolicyRule): { text: string; created: boolean } {
  const document = parseDocument(text);
  if (document.pairs.some((pair) => sameTomlPath(pair.path, RULES_PATH))) {
    throw new KernelError('config_edit_shape_unsupported', { detail: 'policy.rules must use array-of-table headers for rule editing' });
  }
  const rules = ruleTables(document);
  if (op === 'add') {
    const last = rules.at(-1);
    if (last === undefined) {
      const eol = lineEndingAt(text, text.length);
      const prefix = text === ''
        ? ''
        : text.endsWith(`${eol}${eol}`) ? '' : text.endsWith(eol) ? eol : `${eol}${eol}`;
      return { text: `${text}${prefix}${ruleBlockText(rule as PolicyRule, eol)}`, created: true };
    }
    const descendants = ruleDescendants(document, last);
    const tail = descendants.at(-1) ?? last;
    const next = document.tables.find((table) =>
      table.range[0] >= tail.range[1] && !startsWithTomlPath(table.resolvedKey, last.resolvedKey),
    );
    const at = next === undefined
      ? trailingCommentStart(text, document.root) ?? text.length
      : leadingCommentStart(text, document.root, next);
    const eol = lineEndingAt(text, Math.max(0, at - 1));
    const prefix = at === text.length && !text.slice(0, at).endsWith('\n') ? eol : '';
    return {
      text: applyTextEdits(text, [{ start: at, end: at, text: `${prefix}${ruleBlockText(rule as PolicyRule, eol)}` }]),
      created: false,
    };
  }

  const target = rules[index];
  if (target === undefined) {
    throw new KernelError('config_rule_index', { detail: `that file has ${rules.length} rules, so rule ${index} is not one of them` });
  }
  if (op === 'remove') {
    const edits = ruleDescendants(document, target).map((table) => ruleTableEdit(text, document, table));
    return { text: applyTextEdits(text, edits), created: false };
  }

  const wanted = rule as PolicyRule;
  const fields = document.pairs.filter((pair) =>
    startsWithTomlPath(pair.path, target.resolvedKey) && pair.path.length === target.resolvedKey.length + 1,
  );
  const seen = new Set<string>();
  const edits: TextEdit[] = [];
  for (const pair of fields) {
    const name = String(pair.path.at(-1));
    if (!(RULE_FIELDS as readonly string[]).includes(name)) continue;
    seen.add(name);
    const value = wanted[name as keyof PolicyRule];
    if (value === undefined) {
      edits.push({
        start: lineStart(text, pair.node.range[0]),
        end: lineEnd(text, pair.node.range[1] - 1),
        text: '',
      });
    } else {
      edits.push(changeTomlValue(pair, JSON.stringify(value)));
    }
  }
  const toAdd = RULE_FIELDS.filter((key) => wanted[key] !== undefined && !seen.has(key));
  if (toAdd.length > 0) {
    const retained = fields.filter((pair) => {
      const name = String(pair.path.at(-1));
      return valueShape(pair.node.value) !== 'a multi-line string'
        && (!(RULE_FIELDS as readonly string[]).includes(name) || wanted[name as keyof PolicyRule] !== undefined);
    });
    const last = retained.at(-1);
    const anchor = last?.node.range[1] ?? target.key.range[0];
    const at = lineEnd(text, anchor);
    const eol = lineEndingAt(text, anchor);
    const prefix = at === text.length && !text.endsWith('\n') ? eol : '';
    edits.push({ start: at, end: at, text: `${prefix}${toAdd.map((key) => `${key} = ${JSON.stringify(wanted[key])}${eol}`).join('')}` });
  }
  return { text: applyTextEdits(text, edits), created: false };
}

/** 解析规则表；遇到无效条目时返回错误，不静默丢弃。 */
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

/** 根据本次修改计算预期的回读结果。 */
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

// 统一生成比较用的规则表示；未知字段不参与比较。
export function digestRules(list: PolicyRule[]): string {
  return list
    .map((rule) => RULE_FIELDS.map((key) => `${key}=${JSON.stringify(rule[key] ?? '')}`).join(' '))
    .join('\n');
}
