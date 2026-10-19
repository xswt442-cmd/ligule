// 使用 tree-sitter-pwsh 解析 PowerShell 命令。
// 仅接受简单命令和 ASCII 字面参数，并将每个命令分段交给权限规则检查。
// 管道、子表达式、脚本块、重定向、动态表达式、未知节点和解析失败都会返回无法识别的原因，不猜测其含义。
// grammar 是 ESM 模块，需使用动态 import 加载。
import type { CommandInspection, ParsedCommand, ParsedCommandArgument, ParsedCommandInvocation } from './command.js';

// 只接受命令名称、参数分隔符、字面参数、引号字符串和语句分隔符等已支持的节点。
// 新增语法节点前必须确认它不会改变命令执行路径。
const ALLOWED_NAMED = new Set([
  'program', 'statement_list', 'pipeline', 'pipeline_chain', 'pipeline_chain_tail',
  'command', 'command_name', 'command_elements', 'command_argument_sep',
  'command_parameter', 'generic_token', 'empty_statement',
  'unary_expression', 'string_literal', 'verbatim_string_characters', 'expandable_string_literal',
  'integer_literal', 'decimal_integer_literal',
]);

// 仅接受引号和两种语句连接符。PowerShell 管道传递运行时对象，静态解析无法确认下一段收到的类型，因此不支持 `|`。
const ALLOWED_TOKENS = new Set(['"', "'", ';', '&&']);

// PowerShell 会将部分 Unicode 字符作为引号或连字符别名；为避免解析与执行行为不一致，拒绝包含这些字符的命令。
const UNICODE_ALIASES = /[‘’“”–—―]/;

// 字面参数仅接受可打印 ASCII，且不允许 `$` 和反引号，以排除变量展开和转义。
const LITERAL = /^[ -~]+$/;
function isLiteral(text: string): boolean {
  return LITERAL.test(text) && !text.includes('$') && !text.includes('`');
}

interface SyntaxNode {
  type: string;
  text: string;
  isNamed: boolean;
  hasError: boolean;
  childCount: number;
  child(index: number): SyntaxNode;
  startIndex: number;
  endIndex: number;
}

interface GrammarParser {
  parse(text: string): { rootNode: SyntaxNode };
  setLanguage(language: unknown): void;
}

interface ParserConstructor {
  new (): GrammarParser;
}

let loading: Promise<GrammarParser | undefined> | undefined;

// 解析器加载失败不应阻止 Kernel 启动；保存失败原因，并将该语法标记为不可用。
function loadParser(): Promise<GrammarParser | undefined> {
  if (loading === undefined) {
    loading = (async () => {
      try {
        const treeSitter = (await import('tree-sitter')) as unknown as { default: ParserConstructor };
        // 包入口不含 NodeNext 可识别的扩展名，因此通过包内路径加载绑定入口。
        const grammar = (await import('tree-sitter-pwsh/bindings/node/index.js')) as unknown as { default: unknown };
        const parser = new treeSitter.default();
        parser.setLanguage(grammar.default);
        return parser;
      } catch {
        return undefined;
      }
    })();
  }
  return loading;
}

function analyse(root: SyntaxNode, text: string): ParsedCommand {
  if (UNICODE_ALIASES.test(text)) return { kind: 'unsupported', construct: 'a Unicode syntax alias' };
  if (root.hasError) return { kind: 'unsupported', construct: 'a syntax error' };
  const commands: SyntaxNode[] = [];
  const pending: SyntaxNode[] = [root];
  for (let index = 0; index < pending.length; index += 1) {
    const node = pending[index];
    if (node.isNamed) {
      if (!ALLOWED_NAMED.has(node.type)) return { kind: 'unsupported', construct: node.type };
      // 双引号字符串可能展开变量或子表达式；解析器无法确认展开结果，因此拒绝包含 `$` 或 `$(` 的参数。
      if (node.type === 'expandable_string_literal' && (node.text.includes('$') || node.text.includes('`'))) {
        return { kind: 'unsupported', construct: 'an expandable string' };
      }
      if ((node.type === 'command_name' || node.type === 'generic_token' || node.type === 'command_parameter') && !isLiteral(node.text)) {
        return { kind: 'unsupported', construct: `a non-literal ${node.type}` };
      }
      if (node.type === 'command') commands.push(node);
    } else if (!ALLOWED_TOKENS.has(node.type) && node.text.trim() !== '') {
      return { kind: 'unsupported', construct: node.text.trim() };
    }
    for (let child = 0; child < node.childCount; child += 1) pending.push(node.child(child));
  }
  if (commands.length === 0) return { kind: 'unsupported', construct: 'no command' };
  return {
    kind: 'segments',
    segments: commands
      .sort((left, right) => left.startIndex - right.startIndex)
      .map((node) => text.slice(node.startIndex, node.endIndex).trim()),
  };
}

function childrenOf(node: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child.isNamed) children.push(child);
  }
  return children;
}

interface PowerShellArgumentValue {
  value: string | undefined;
  dynamic: boolean;
}

function argumentValue(node: SyntaxNode): PowerShellArgumentValue {
  const source = node.text;
  if (source.startsWith("'") && source.endsWith("'")) {
    return { value: source.slice(1, -1).replaceAll("''", "'"), dynamic: false };
  }
  if (node.type === 'command_parameter') {
    return { value: node.text, dynamic: node.text.includes('$') || node.text.includes('`') };
  }
  if (node.type === 'generic_token' || node.type === 'integer_literal' || node.type === 'decimal_integer_literal') {
    return { value: source, dynamic: false };
  }
  if (node.type === 'variable') return { value: node.text, dynamic: true };
  if (node.type === 'verbatim_string_characters') return { value: node.text, dynamic: false };
  if (node.type === 'expandable_string_literal') {
    const content = node.text.slice(1, -1);
    if (content.includes('`') || childrenOf(node).some((child) => child.type === 'sub_expression')) {
      return { value: undefined, dynamic: true };
    }
    return { value: content, dynamic: content.includes('$') };
  }
  if (node.type === 'string_literal' || node.type === 'unary_expression' || node.type === 'expandable_bareword') {
    const children = childrenOf(node);
    if (children.length === 0) return { value: undefined, dynamic: true };
    let value = '';
    let dynamic = false;
    let complete = true;
    for (const child of children) {
      if (child.type === 'sub_expression') {
        complete = false;
        dynamic = true;
        continue;
      }
      const nested = argumentValue(child);
      if (nested.value === undefined) complete = false;
      else value += nested.value;
      dynamic ||= nested.dynamic;
    }
    return { value: complete ? value : undefined, dynamic };
  }
  if (node.type === 'sub_expression') return { value: undefined, dynamic: true };
  return { value: undefined, dynamic: true };
}

function nestedPowerShellCommands(node: SyntaxNode, text: string): ParsedCommandInvocation[] {
  const found: ParsedCommandInvocation[] = [];
  const visit = (candidate: SyntaxNode, pipeline = false) => {
    if (candidate.type === 'command') {
      found.push(powerShellInvocation(candidate, text, true, pipeline));
      return;
    }
    const inPipeline = pipeline || (candidate.type === 'pipeline' && commandCount(candidate) > 1);
    for (const child of childrenOf(candidate)) visit(child, inPipeline);
  };
  for (const child of childrenOf(node)) visit(child);
  return found;
}

function powerShellArgument(node: SyntaxNode, text: string): ParsedCommandArgument {
  const inspected = argumentValue(node);
  return {
    source: text.slice(node.startIndex, node.endIndex),
    value: inspected.value,
    dynamic: inspected.dynamic,
    tildeExpansion: false,
    nested: nestedPowerShellCommands(node, text),
  };
}

function powerShellInvocation(node: SyntaxNode, text: string, nested: boolean, pipeline: boolean): ParsedCommandInvocation {
  const children = childrenOf(node);
  const commandName = children.find((child) => child.type === 'command_name');
  const elements = children.find((child) => child.type === 'command_elements');
  const args = elements === undefined
    ? []
    : childrenOf(elements)
      .filter((child) => child.type !== 'command_argument_sep')
      .map((child) => powerShellArgument(child, text));
  return { executable: commandName?.text ?? '', executableSource: commandName?.text ?? '', arguments: args, nested, pipeline };
}

function commandCount(node: SyntaxNode): number {
  if (node.type === 'command') return 1;
  return childrenOf(node).reduce((count, child) => count + commandCount(child), 0);
}

function powerShellInvocations(root: SyntaxNode, text: string): ParsedCommandInvocation[] {
  const found: ParsedCommandInvocation[] = [];
  const visit = (node: SyntaxNode, nested: boolean, pipeline: boolean) => {
    if (node.type === 'command') {
      if (!node.hasError) found.push(powerShellInvocation(node, text, nested, pipeline));
      return;
    }
    const nestedCommand = nested || node.type === 'sub_expression';
    const inPipeline = pipeline || (node.type === 'pipeline' && commandCount(node) > 1);
    for (const child of childrenOf(node)) visit(child, nestedCommand, inPipeline);
  };
  visit(root, false, false);
  return found;
}

// 返回解析状态和从同一 PowerShell AST 提取的调用参数。
export async function inspectPowerShellCommand(text: string): Promise<CommandInspection> {
  const parser = await loadParser();
  if (parser === undefined) {
    return {
      parsed: { kind: 'unavailable', detail: 'the PowerShell grammar (tree-sitter-pwsh) could not be loaded' },
      invocations: [],
    };
  }
  try {
    const root = parser.parse(text).rootNode;
    return { parsed: analyse(root, text), invocations: powerShellInvocations(root, text) };
  } catch (error) {
    return {
      parsed: { kind: 'unavailable', detail: error instanceof Error ? error.message : String(error) },
      invocations: [],
    };
  }
}

// 解析失败时保留解析状态，策略层不会自动批准。
export async function parsePowerShell(text: string): Promise<ParsedCommand> {
  return (await inspectPowerShellCommand(text)).parsed;
}
