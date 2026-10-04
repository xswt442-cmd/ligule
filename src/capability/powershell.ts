// PowerShell 的语法判定（D59、D66）：命令文本交给 tree-sitter-pwsh 解析一次，
// 只有整棵树都落在「简单命令 + ASCII 字面参数」这一档里，才把每个 command 交出去逐段套规则。
// 管道、子表达式、脚本块、splatting、调用运算符、重定向、类型字面量、注释、动态表达式、未知节点与解析失败
// 都按「无法完整处理」对待（I8：说得出是哪一种构造），不猜。
// 那一份 grammar 是精确钉版本的第五条运行时依赖（D66），要用动态 import 才拿得到：
// 它是带顶层 await 的 ESM，require 会报 ERR_REQUIRE_ASYNC_MODULE（本机 2026-10-03 实测）。

// 认下来的命名节点：一条命令的名字、参数分隔、字面量参数与引号包住的字面串，再加上语句分隔那一层。
// 要加一个新的节点类型，先说清它能不能把一条文本变成别的执行路径；说不清就不加。
const ALLOWED_NAMED = new Set([
  'program', 'statement_list', 'pipeline', 'pipeline_chain', 'pipeline_chain_tail',
  'command', 'command_name', 'command_elements', 'command_argument_sep',
  'command_parameter', 'generic_token', 'empty_statement',
  'unary_expression', 'string_literal', 'verbatim_string_characters', 'expandable_string_literal',
  'integer_literal', 'decimal_integer_literal',
]);

// 认下来的标点：两种引号与两条语句连接符。`|` 不在其中——PowerShell 的管道传的是对象，
// 前一段是什么类型只有运行时知道，判定读不出「后一段拿到的到底是什么」（D59）。
const ALLOWED_TOKENS = new Set(['"', "'", ';', '&&']);

// PowerShell 把这批 Unicode 字符当作语法别名（弯引号就是引号、长破折号就是 `-`），而树把它们留在字面量中间。
// 整个拼写家族一起挡掉，不去猜某一位到底是不是结构（同一件事 codex 也这样做，
// `codex/codex-rs/shell-command/src/command_safety/powershell_tree_sitter.rs:18-26`）。
const UNICODE_ALIASES = /[‘’“”–—―]/;

// 字面参数的形状：可打印 ASCII，且不含 `$` 与反引号——那两位在 PowerShell 里是变量替换与转义的起点。
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

// 解析器加载失败不能让内核起不来（D18 的显式报告）：记下来，交出去的是「这一档用不了」而不是异常。
function loadParser(): Promise<GrammarParser | undefined> {
  if (loading === undefined) {
    loading = (async () => {
      try {
        const treeSitter = (await import('tree-sitter')) as unknown as { default: ParserConstructor };
        // 那一份包的 `main` 写的是不带扩展名的目录（`bindings/node`），nodenext 认不出这种写法，所以按位置直接引它自己的入口。
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
      // 双引号在 PowerShell 里会展开变量与子表达式，树把 `$(...)` 单列成一个节点，但 `$x` 只是串里的文本；
      // 认不下展开之后的形状就等于猜，所以带这两位的一律不去猜。
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

// 三种结果与 bash 那一份同形：`segments` 是逐段判的依据，`unsupported` 带一个构造名，`unavailable` 说明这一档用不了。
// 解析这一步自己抛异常也归到「用不了」：那是 grammar 的问题，不是命令的内容，判定不该把它读成一条看不透的命令。
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
