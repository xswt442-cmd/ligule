// 声明式自定义工具：TOML 文件描述命令与参数模式，占位符整位替换，
// 执行复用 exec 工具的权限与审批链路；声明本身不授予任何权限。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPermissionContext, discoverCustomTools, resolveShell } from '../dist/index.js';
import { discoverCustomTools as directDiscover } from '../dist/tools/custom.js';

const shell = resolveShell({});
const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
}, { workspaceTrusted: true });

// echo 不是解释器调用，不触发脚本绑定；被测的是声明式工具自己的组合与引号。
async function runTool(tool, args) {
  return tool.run(args, { config: { boundary: process.cwd(), limits: {} }, permission: fullAccess, shell });
}

async function withTools(files, run) {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-custom-tools-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      await writeFile(join(directory, name), text, 'utf8');
    }
    return await run(directory, await directDiscover(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a declared tool runs its command with placeholder arguments as single argv entries', async () => {
  await withTools({
    'shout.toml': `description = "Print a word back"
command = "echo"
args = ["{word}"]

[parameters.properties.word]
type = "string"
description = "The word to print as one argument."

[parameters]
required = ["word"]
`,
  }, async (directory, { tools, diagnostics }) => {
    assert.deepEqual(diagnostics, []);
    assert.equal(tools.length, 1);
    const tool = tools[0];
    assert.equal(tool.name, 'shout');
    assert.equal(tool.access, 'exec');
    assert.equal(tool.capability({}), 'exec', '判定链按 exec 能力展示');
    assert.deepEqual(tool.parameters.required, ['word']);

    const plain = await runTool(tool, { word: 'hello' });
    assert.equal(plain.text.trim(), 'hello', `一个参数位一个值: ${plain.text.slice(0, 120)}`);

    // 参数值带分号、竖线与单引号时仍是一个参数位，不进入 shell 语法。
    const hostile = "a;b|c'd";
    const injection = await runTool(tool, { word: hostile });
    assert.equal(injection.text.trim(), hostile, `参数值原样到达: ${injection.text.slice(0, 120)}`);
  });
});

test('placeholders for optional parameters drop their whole entry when absent', async () => {
  await withTools({
    'labeled.toml': `description = "Print a word with an optional label"
command = "echo"
args = ["{word}", "{label}"]

[parameters.properties.word]
type = "string"

[parameters.properties.label]
type = "string"
`,
  }, async (directory, { tools }) => {
    const tool = tools[0];
    const plain = await runTool(tool, { word: 'hello' });
    assert.deepEqual(plain.text.trim().split(/\s+/u), ['hello'], '可选参数缺省时整位省略');
    const labeled = await runTool(tool, { word: 'hello', label: 'tagged' });
    assert.deepEqual(labeled.text.trim().split(/\s+/u), ['hello', 'tagged'], '提供可选参数时按位出现');
  });
});

test('invalid declarations are reported as diagnostics instead of registering', async () => {
  await withTools({
    'no-description.toml': 'command = "node"\n',
    'spaced-command.toml': 'description = "x"\ncommand = "node -e hi"\n',
    'undeclared.toml': 'description = "x"\ncommand = "node"\nargs = ["{code}"]\n',
    'partial.toml': 'description = "x"\ncommand = "node"\nargs = ["--flag={mode}"]\n[parameters.properties.mode]\ntype = "string"\n',
    'bad-name.toml': 'name = "Not Ok"\ndescription = "x"\ncommand = "node"\n',
    'bad-schema.toml': "description = \"x\"\ncommand = \"node\"\n[parameters.properties.a]\npattern = '^\\d+$'\n",
    'a.toml': 'description = "same"\ncommand = "node"\n',
    'b.toml': 'name = "a"\ndescription = "same"\ncommand = "node"\n',
  }, async (directory, { tools, diagnostics }) => {
    assert.equal(tools.length, 1, 'a.toml 合法，其余无效或重名');
    const codes = diagnostics.map((item) => item.code).sort();
    assert.deepEqual(codes, [
      'custom_tool_invalid', 'custom_tool_invalid', 'custom_tool_invalid', 'custom_tool_invalid',
      'custom_tool_invalid', 'custom_tool_invalid', 'custom_tool_name_taken',
    ]);
    assert.ok(diagnostics.some((item) => item.path.endsWith('bad-schema.toml') && /subset/.test(item.detail)), '模式要落在受支持子集内');
    assert.ok(diagnostics.some((item) => item.path.endsWith('partial.toml') && /whole entry/.test(item.detail)), '半截占位符要说清');
  });
});

test('a missing directory yields no tools and no diagnostics', async () => {
  const found = await directDiscover(join(tmpdir(), `missing-${Date.now()}`));
  assert.deepEqual(found, { tools: [], diagnostics: [] });
});

test('discoverCustomTools is re-exported from the package root', async () => {
  assert.equal(typeof discoverCustomTools, 'function');
});
