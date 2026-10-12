// 规则与文件名共用的匹配写法：第一版只有前缀与含 `*` 的通配两种（D15 对命令动作匹配的规定）。
// 前缀匹配要求匹配到完整的参数边界，否则规则 `git status` 会顺带放行 `git statusfoo`。
function escapeLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matches(input, pattern) {
  if (pattern === undefined) return true;
  if (input === undefined) return false;
  if (pattern.includes('*')) {
    return new RegExp(`^${pattern.split('*').map(escapeLiteral).join('[\\s\\S]*')}$`).test(input);
  }
  return input === pattern || input.startsWith(`${pattern} `);
}

// 文件名的通配匹配：`*` 与 `?` 不跨路径分隔符，`**` 跨，`**/` 那一段可以是零层目录（`**/*.js` 要能命根下那一个 `.js`）。
// 比较之前路径要写成斜杠形式。
export function matchesName(name, pattern) {
  const source = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/g)
    .map((part) => (part === '**/' ? '(?:[^/]*/)*' : part === '**' ? '[\\s\\S]*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : escapeLiteral(part)))
    .join('');
  return new RegExp(`^${source}$`).test(name);
}
