// 命令文本的语法级判断（D15、D17）：用 tree-sitter 的 bash 语法解析一次，
// 只有整棵树都落在支持的语法子集里，才把每个 command 叶子交出去逐段套规则；
// 树里出现子集之外的构造、解析报错、或者解析器根本加载不起来，三种都按「无法完整处理」对待。
// 解析器是原生插件，加载失败不能让内核起不来，所以这里是懒加载并把失败记下来（D18 的显式报告）。
import { createRequire } from 'node:module';

// 允许的命名单点，照 Codex 那一份清单：容器、命令与字面量，没有替换、重定向与控制流。
const SUPPORTED_KINDS = new Set([
  'program', 'list', 'pipeline', 'command', 'command_name',
  'word', 'string', 'string_content', 'raw_string', 'number', 'concatenation',
]);

// 允许的标点与操作符：只有安全的连接符与两种引号，括号、反引号、重定向一律不在其中。
const SUPPORTED_TOKENS = new Set(['&&', '||', ';', '|', '"', "'"]);

let loaded;

// tree-sitter 是 CommonJS 的原生绑定，用 require 拿；静态 import 会在加载失败时把整个进程带走。
function loadParser() {
  if (loaded !== undefined) return loaded;
  try {
    const require = createRequire(import.meta.url);
    const Parser = require('tree-sitter');
    const parser = new Parser();
    parser.setLanguage(require('tree-sitter-bash'));
    loaded = { parser };
  } catch (error) {
    loaded = { detail: typeof error?.message === 'string' ? error.message : String(error) };
  }
  return loaded;
}

function analyse(tree, text) {
  // 解析不了就整条按无法处理对待，不去猜哪一段是模型想写的。
  if (tree.rootNode.hasError) return { kind: 'unsupported', construct: 'a syntax error' };
  const commands = [];
  const stack = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.isNamed) {
      if (!SUPPORTED_KINDS.has(node.type)) return { kind: 'unsupported', construct: node.type };
      if (node.type === 'command') commands.push(node);
    } else if (!SUPPORTED_TOKENS.has(node.type) && node.text.trim() !== '') {
      return { kind: 'unsupported', construct: node.type };
    }
    for (let index = 0; index < node.childCount; index += 1) stack.push(node.child(index));
  }
  // 遍历用的是栈，交出去之前按在原文里的位置排回来。
  commands.sort((left, right) => left.startIndex - right.startIndex);
  const segments = commands
    .map((node) => text.slice(node.startIndex, node.endIndex).trim())
    .filter((segment) => segment !== '');
  if (segments.length === 0) return { kind: 'unsupported', construct: 'no command' };
  return { kind: 'segments', segments };
}

// 三种结果：`segments` 是逐段判的依据；`unsupported` 带一个说明是哪种构造的字段；
// `unavailable` 说明解析器这一次运行里用不了，按语法自动放行这条能力整个关掉。
export function parseCommand(text) {
  if (typeof text !== 'string' || text.trim() === '') return { kind: 'unsupported', construct: 'no command' };
  const state = loadParser();
  if (state.parser === undefined) return { kind: 'unavailable', detail: state.detail };
  let tree;
  try {
    tree = state.parser.parse(text);
  } catch (error) {
    return { kind: 'unavailable', detail: typeof error?.message === 'string' ? error.message : String(error) };
  }
  return analyse(tree, text);
}
