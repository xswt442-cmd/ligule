// 根据 Host 选定的解释器解析命令，再逐段应用权限规则。
// Bash 仅接受解析树完全位于支持子集内的命令；不支持的语法、解析错误或解析器故障均按无法完整识别处理。
// PowerShell 使用 `powershell.js` 中更严格的语法子集，两种解析器返回相同结果结构。
// 解析器采用延迟加载；加载失败时记录原因，不阻止 Kernel 启动。
import { createRequire } from 'node:module';
import { inspectPowerShellCommand } from './powershell.js';
import type TreeSitterParser from 'tree-sitter';

export type ParsedCommand =
  | { kind: 'segments'; segments: string[] }
  | { kind: 'unsupported'; construct: string }
  | { kind: 'unavailable'; detail: string };

export interface ParsedCommandArgument {
  readonly source: string;
  readonly value: string | undefined;
  readonly dynamic: boolean;
  readonly tildeExpansion: boolean;
  readonly nested: readonly ParsedCommandInvocation[];
}

export interface ParsedCommandInvocation {
  readonly executable: string;
  readonly arguments: readonly ParsedCommandArgument[];
  readonly nested: boolean;
  readonly pipeline: boolean;
}

export interface CommandInspection {
  readonly parsed: ParsedCommand;
  readonly invocations: readonly ParsedCommandInvocation[];
}

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

function childrenOf(node: TreeSitterParser.SyntaxNode): TreeSitterParser.SyntaxNode[] {
  const children: TreeSitterParser.SyntaxNode[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child === null) throw new Error('the syntax tree changed during traversal');
    if (child.isNamed) children.push(child);
  }
  return children;
}

interface BashArgumentValue {
  value: string | undefined;
  dynamic: boolean;
  tildeExpansion: boolean;
}

function decodeDoubleQuotedContent(value: string): string {
  return value.replace(/\\([$`"\\\n])/gu, (_match, character: string) => character === '\n' ? '' : character);
}

function bashArgumentValue(node: TreeSitterParser.SyntaxNode, inDoubleQuote = false): BashArgumentValue {
  const source = node.text;
  if (node.type === 'word' && node.childCount === 0) {
    return { value: source, dynamic: false, tildeExpansion: /^~(?:\/|$)/u.test(source) };
  }
  if (node.type === 'number' || node.type === 'string_content') {
    return {
      value: inDoubleQuote ? decodeDoubleQuotedContent(source) : source,
      dynamic: false,
      tildeExpansion: false,
    };
  }
  if (node.type === 'raw_string') {
    return { value: source.slice(1, -1), dynamic: false, tildeExpansion: false };
  }
  if (node.type === 'simple_expansion') {
    return { value: source, dynamic: true, tildeExpansion: false };
  }
  if (node.type === 'command_substitution' || node.type === 'process_substitution') {
    return { value: undefined, dynamic: true, tildeExpansion: false };
  }
  if (node.type === 'expansion' && /^\$\{(?:HOME|USERPROFILE)\}$/iu.test(source)) {
    return { value: '$HOME', dynamic: true, tildeExpansion: false };
  }

  const children = childrenOf(node);
  if (children.length === 0) return { value: undefined, dynamic: true, tildeExpansion: false };
  let value = '';
  let dynamic = false;
  let tildeExpansion = false;
  let complete = true;
  for (const child of children) {
    if (child.type === 'command_substitution' || child.type === 'process_substitution') {
      dynamic = true;
      complete = false;
      continue;
    }
    if (child.type === 'expansion' && !/^\$\{(?:HOME|USERPROFILE)\}$/iu.test(child.text)) {
      dynamic = true;
      complete = false;
      continue;
    }
    const childValue = bashArgumentValue(child, node.type === 'string' || inDoubleQuote);
    if (childValue.value === undefined) complete = false;
    else value += childValue.value;
    dynamic ||= childValue.dynamic;
    tildeExpansion ||= childValue.tildeExpansion;
  }
  return { value: complete ? value : undefined, dynamic, tildeExpansion };
}

function nestedBashCommands(node: TreeSitterParser.SyntaxNode, text: string): ParsedCommandInvocation[] {
  const found: ParsedCommandInvocation[] = [];
  const visit = (candidate: TreeSitterParser.SyntaxNode, pipeline = false) => {
    if (candidate.type === 'command') {
      found.push(bashInvocation(candidate, text, true, pipeline));
      return;
    }
    const inPipeline = pipeline || (candidate.type === 'pipeline' && commandCount(candidate) > 1);
    for (const child of childrenOf(candidate)) visit(child, inPipeline);
  };
  for (const child of childrenOf(node)) visit(child);
  return found;
}

function bashArgument(node: TreeSitterParser.SyntaxNode, text: string): ParsedCommandArgument {
  const inspected = bashArgumentValue(node);
  return {
    source: text.slice(node.startIndex, node.endIndex),
    value: inspected.value,
    dynamic: inspected.dynamic,
    tildeExpansion: inspected.tildeExpansion,
    nested: nestedBashCommands(node, text),
  };
}

function bashInvocation(node: TreeSitterParser.SyntaxNode, text: string, nested: boolean, pipeline: boolean): ParsedCommandInvocation {
  const children = childrenOf(node);
  const commandName = children.find((child) => child.type === 'command_name');
  const executable = commandName?.text ?? '';
  const args = children
    .filter((child) => child !== commandName)
    .map((child) => bashArgument(child, text));
  return { executable, arguments: args, nested, pipeline };
}

function commandCount(node: TreeSitterParser.SyntaxNode): number {
  if (node.type === 'command') return 1;
  return childrenOf(node).reduce((count, child) => count + commandCount(child), 0);
}

function bashInvocations(root: TreeSitterParser.SyntaxNode, text: string): ParsedCommandInvocation[] {
  const found: ParsedCommandInvocation[] = [];
  const visit = (node: TreeSitterParser.SyntaxNode, nested: boolean, pipeline: boolean) => {
    if (node.type === 'command') {
      if (!node.hasError) found.push(bashInvocation(node, text, nested, pipeline));
      return;
    }
    const nestedCommand = nested || node.type === 'command_substitution' || node.type === 'process_substitution';
    const inPipeline = pipeline || (node.type === 'pipeline' && commandCount(node) > 1);
    for (const child of childrenOf(node)) visit(child, nestedCommand, inPipeline);
  };
  visit(root, false, false);
  return found;
}

// 返回 `segments` 供逐段判定，`unsupported` 标明不支持的语法，`unavailable` 表示解析器不可用。
// 解析器均通过异步接口加载，确保 Bash 和 PowerShell 使用相同调用方式。
export async function inspectCommand(text: string, kind: string = 'bash'): Promise<CommandInspection> {
  if (typeof text !== 'string' || text.trim() === '') {
    return { parsed: { kind: 'unsupported', construct: 'no command' }, invocations: [] };
  }
  if (kind === 'powershell') return inspectPowerShellCommand(text);
  const state = loadParser();
  if (!('parser' in state)) return { parsed: { kind: 'unavailable', detail: state.detail }, invocations: [] };
  try {
    const tree = state.parser.parse(text);
    return { parsed: analyse(tree, text), invocations: bashInvocations(tree.rootNode, text) };
  } catch (error) {
    return { parsed: { kind: 'unavailable', detail: messageOf(error) }, invocations: [] };
  }
}

export async function parseCommand(text: string, kind: string = 'bash'): Promise<ParsedCommand> {
  return (await inspectCommand(text, kind)).parsed;
}
