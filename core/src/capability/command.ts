// 根据 Host 选定的解释器解析命令，再逐段应用权限规则。
// Bash 仅接受解析树完全位于支持子集内的命令；不支持的语法、解析错误或解析器故障均按无法完整识别处理。
// PowerShell 使用 `powershell.js` 中更严格的语法子集，两种解析器返回相同结果结构。
// 解析器采用延迟加载；加载失败时记录原因，不阻止 Kernel 启动。
import { createRequire } from 'node:module';
import { parsePowerShell } from './powershell.js';
import type TreeSitterParser from 'tree-sitter';

type ParsedCommand =
  | { kind: 'segments'; segments: string[] }
  | { kind: 'unsupported'; construct: string }
  | { kind: 'unavailable'; detail: string };

type LoadedParser = { parser: TreeSitterParser } | { detail: string };

// 支持的语法节点包括命令、参数和字面量；不支持替换、重定向或控制流。
const SUPPORTED_KINDS = new Set([
  'program', 'list', 'pipeline', 'command', 'command_name',
  'word', 'string', 'string_content', 'raw_string', 'number', 'concatenation',
]);

// 仅接受安全的命令连接符和两种引号；括号、反引号及重定向不在支持范围内。
const SUPPORTED_TOKENS = new Set(['&&', '||', ';', '|', '"', "'"]);

let loaded: LoadedParser | undefined;

// tree-sitter 使用 CommonJS 原生绑定，通过 require 加载，避免导入失败时终止整个进程。
function messageOf(error: unknown): string {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    if ('message' in error && typeof error.message === 'string') return error.message;
  }
  return String(error);
}

function loadParser(): LoadedParser {
  if (loaded !== undefined) return loaded;
  try {
    const require = createRequire(import.meta.url);
    const ParserConstructor: typeof TreeSitterParser = require('tree-sitter');
    const grammar: TreeSitterParser.Language = require('tree-sitter-bash');
    const parser = new ParserConstructor();
    parser.setLanguage(grammar);
    loaded = { parser };
  } catch (error) {
    loaded = { detail: messageOf(error) };
  }
  return loaded;
}

function analyse(tree: TreeSitterParser.Tree, text: string): ParsedCommand {
  // 解析失败时拒绝整条命令，不猜测模型意图。
  if (tree.rootNode.hasError) return { kind: 'unsupported', construct: 'a syntax error' };
  const commands: TreeSitterParser.SyntaxNode[] = [];
  const stack: TreeSitterParser.SyntaxNode[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) throw new Error('the syntax tree traversal stack became empty');
    if (node.isNamed) {
      if (!SUPPORTED_KINDS.has(node.type)) return { kind: 'unsupported', construct: node.type };
      if (node.type === 'command') commands.push(node);
    } else if (!SUPPORTED_TOKENS.has(node.type) && node.text.trim() !== '') {
      return { kind: 'unsupported', construct: node.type };
    }
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child === null) throw new Error('the syntax tree changed during traversal');
      stack.push(child);
    }
  }
  // 使用栈遍历语法树，返回前按命令在原文中的位置排序。
  commands.sort((left, right) => left.startIndex - right.startIndex);
  const segments = commands
    .map((node) => text.slice(node.startIndex, node.endIndex).trim())
    .filter((segment) => segment !== '');
  if (segments.length === 0) return { kind: 'unsupported', construct: 'no command' };
  return { kind: 'segments', segments };
}

// 返回 `segments` 供逐段判定，`unsupported` 标明不支持的语法，`unavailable` 表示解析器不可用。
// 解析器均通过异步接口加载，确保 Bash 和 PowerShell 使用相同调用方式。
export function parseCommand(text: string, kind: string = 'bash'): Promise<ParsedCommand> {
  if (typeof text !== 'string' || text.trim() === '') return Promise.resolve({ kind: 'unsupported', construct: 'no command' });
  if (kind === 'powershell') return parsePowerShell(text);
  const state = loadParser();
  if (!('parser' in state)) return Promise.resolve({ kind: 'unavailable', detail: state.detail });
  try {
    return Promise.resolve(analyse(state.parser.parse(text), text));
  } catch (error) {
    return Promise.resolve({ kind: 'unavailable', detail: messageOf(error) });
  }
}
