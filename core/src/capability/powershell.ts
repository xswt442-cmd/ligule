// 使用 tree-sitter-pwsh 解析 PowerShell 命令。
// 仅接受简单命令和 ASCII 字面参数，并将每个命令分段交给权限规则检查。
// 管道、子表达式、脚本块、重定向、动态表达式、未知节点和解析失败都会返回无法识别的原因，不猜测其含义。
// grammar 是 ESM 模块，需使用动态 import 加载。

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

export type ParsedCommand =
  | { kind: 'segments'; segments: string[] }
  | { kind: 'unsupported'; construct: string }
  | { kind: 'unavailable'; detail: string };

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

// 返回可供逐段判定的 `segments`、带构造名称的 `unsupported`，或说明解析器不可用的 `unavailable`。
// 解析器异常属于解析器故障，不能误报为命令语法不受支持。
export async function parsePowerShell(text: string): Promise<ParsedCommand> {
  const parser = await loadParser();
  if (parser === undefined) {
    return { kind: 'unavailable', detail: 'the PowerShell grammar (tree-sitter-pwsh) could not be loaded' };
  }
  try {
    return analyse(parser.parse(text).rootNode, text);
  } catch (error) {
    return { kind: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
  }
}
