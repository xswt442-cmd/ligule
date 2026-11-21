import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const lint = fileURLToPath(new URL('../skills/myshuohua/scripts/lint-shuohua.mjs', import.meta.url));

function run(files, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'myshuohua-lint-'));
  const paths = [];
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    writeFileSync(path, content);
    if (/\.md$/i.test(name)) paths.push(path);
  }
  const result = spawnSync(process.execPath, [lint, ...args, ...paths], { encoding: 'utf8', cwd: dir });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('a dense paragraph is reported but does not fail the run', () => {
  const { status, output } = run({
    'README.md': '## 功能\n\n收藏和历史存在本机；备注存在本机；预设存在本机；颜色也存在本机；目录按会话隔离，预设不存密码。\n',
  });
  assert.match(output, /semicolon-density/);
  assert.equal(status, 0);
});

test('--strict turns the same warning into a failure', () => {
  const { status } = run({
    'README.md': '## 功能\n\n收藏和历史存在本机；备注存在本机；预设存在本机；颜色也存在本机；目录按会话隔离，预设不存密码。\n',
  }, ['--strict']);
  assert.equal(status, 1);
});

test('code blocks and inline code are not counted', () => {
  const { status, output } = run({
    'README.md': '## 用法\n\n```sh\nfoo; bar; baz; qux; quux\n```\n\n用 `a; b; c; d` 这样的写法。\n',
  });
  assert.doesNotMatch(output, /semicolon-density/);
  assert.equal(status, 0);
});

test('a clean file exits zero and says so', () => {
  const { status, output } = run({
    'README.md': '## 用法\n\n运行 `tool --help` 查看参数。\n',
  });
  assert.match(output, /没发现问题/);
  assert.equal(status, 0);
});

test('a quoted bad example can switch a rule off for one line', () => {
  const { output } = run({
    'README.md': [
      '## 用法',
      '',
      '<!-- lint-ignore-next-line term-casing -->',
      '别写「快速 cd」，要写「快速 CD」。',
      '',
      '别写「快速 cd」，要写「快速 CD」。',
      '',
    ].join('\n'),
  });
  const hits = output.split('\n').filter((line) => line.includes('term-casing'));
  assert.equal(hits.length, 1);
  assert.match(hits[0], /^\s+6\s/);
});

test('several bad words on one line produce one finding', () => {
  const { output } = run({
    'README.md': '## 功能\n\n开箱即用的多源播放，强大的扩展能力。\n',
  });
  const hits = output.split('\n').filter((line) => line.includes('banned-phrases'));
  assert.equal(hits.length, 1);
  assert.match(hits[0], /开箱即用/);
  assert.match(hits[0], /强大的/);
});

test('a word inside inline code does not count', () => {
  const { output } = run({
    'README.md': '## 用法\n\n文档里别写 `开箱即用` 这种词。\n',
  });
  assert.doesNotMatch(output, /banned-phrases/);
});

test('a file quoting bad examples can switch the rule off wholesale', () => {
  const { status, output } = run({
    'README.md': '<!-- lint-ignore-file banned-phrases -->\n\n## 功能\n\n开箱即用，零门槛上手。\n',
  });
  assert.doesNotMatch(output, /banned-phrases/);
  assert.equal(status, 0);
});

test('pattern rules keep their own level', () => {
  const { status, output } = run({
    'README.md': '## 用法\n\n这个开关不是全局的，而是按会话生效。\n',
  });
  assert.match(output, /转折句式/);
  assert.equal(status, 0);
});

test('a one-character verb with a negative complement is reported', () => {
  const { output } = run({
    'README.md': '## 用法\n\n取不到配置文件时按默认值启动。\n',
  });
  assert.match(output, /取不到/);
  assert.match(output, /无法读取/);
});

test('two patterns on one line are both reported', () => {
  const { output } = run({
    'README.md': '## 用法\n\n连不上服务就查一下端口。\n',
  });
  assert.match(output, /连不上/);
  assert.match(output, /查一下/);
});

test('high-confidence casual wording and engineering jargon fail by default', () => {
  const { status, output } = run({
    'README.md': '## 使用\n\n这块处理一下，再走一遍就行，最后打通链路。\n',
  });
  assert.equal(status, 1);
  assert.match(output, /error\s+banned-phrases/);
  assert.match(output, /这块/);
  assert.match(output, /打通链路/);
  assert.match(output, /建议：/);
});

test('vague processing stays a warning unless strict mode is enabled', () => {
  const files = {
    'docs.md': '## 处理\n\n对请求进行相关处理。\n',
  };
  const normal = run(files);
  assert.equal(normal.status, 0);
  assert.match(normal.output, /warning\s+banned-phrases/);
  assert.match(normal.output, /相关处理/);
  assert.equal(run(files, ['--strict']).status, 1);
});

test('wording rules leave verified technical statements alone', () => {
  const { status, output } = run({
    'README.md': '## 限制\n\n配置读取失败时保留原有文件，并返回读取错误。\n',
  });
  assert.equal(status, 0);
  assert.doesNotMatch(output, /banned-phrases/);
});

test('inline code and fenced examples do not trigger severe wording rules', () => {
  const { status, output } = run({
    'README.md': '## 示例\n\n命令中的 `这块` 保持原样。\n\n```text\n打通链路\n搞定\n```\n',
  });
  assert.equal(status, 0);
  assert.doesNotMatch(output, /banned-phrases/);
});

test('high-confidence wording can be suppressed for a quoted source example', () => {
  const { status, output } = run({
    'README.md': '<!-- lint-ignore-next-line banned-phrases -->\n这块已经搞定。\n\n配置读取失败时返回错误。\n',
  });
  assert.equal(status, 0);
  assert.doesNotMatch(output, /banned-phrases/);
});

test('JSON diagnostics preserve severe and advisory levels', () => {
  const { status, output } = run({
    'README.md': '## 使用\n\n这边已经搞定。\n\n对接口进行相关处理。\n',
  }, ['--json']);
  assert.equal(status, 1);
  const report = JSON.parse(output);
  const levels = report.findings.filter((f) => f.rule === 'banned-phrases').map((f) => f.level);
  assert.ok(levels.includes('error'));
  assert.ok(levels.includes('warning'));
});

test('duplicated API sentences on the same line are caught after paragraph splitting', () => {
  const sentence = '列表包含名称、前缀、创建时间、到期时间和撤销时间。';
  const files = { 'API.zh-CN.md': '## 密钥元数据\n\n' + sentence + '已撤销的密钥仍会列出，直到用户删除。' + sentence + '\n' };
  const normal = run(files);
  assert.equal(normal.status, 0);
  assert.match(normal.output, /duplicate-sentences/);
  assert.match(normal.output, /重复/);
  assert.equal(run(files, ['--strict']).status, 1);
});

test('repeated complete sentences are detected across paragraphs despite punctuation spacing', () => {
  const { output } = run({
    'README.md': '## 限制\n\n配置加载失败时保留已有文件，并返回具体的错误信息。\n\n配置加载失败时保留已有文件, 并返回具体的错误信息。\n',
  });
  assert.match(output, /duplicate-sentences/);
});

test('short formulaic sentences and quoted or coded examples are not duplicate errors', () => {
  const { output } = run({
    'README.md': '## 状态\n\n请求成功。请求成功。\n\n> 配置加载失败时保留已有文件，并返回具体的错误信息。\n> 配置加载失败时保留已有文件，并返回具体的错误信息。\n\n```text\n配置加载失败时保留已有文件，并返回具体的错误信息。\n配置加载失败时保留已有文件，并返回具体的错误信息。\n```\n',
  });
  assert.doesNotMatch(output, /duplicate-sentences/);
});

test('project glossary checks optional terminology without modifying it', () => {
  const files = {
    'README.md': '## 功能\n\n当前模块支持跨流对轴，手动配置偏移后执行验证。\n',
    'terms.json': JSON.stringify({ terms: [{ preferred: '跨流时间对齐', avoid: ['跨流对轴'] }] }),
  };
  const normal = run(files);
  assert.doesNotMatch(normal.output, /term-preference/);
  const withTerms = run(files, ['--glossary', 'terms.json']);
  assert.equal(withTerms.status, 0);
  assert.match(withTerms.output, /term-preference/);
  assert.match(withTerms.output, /跨流时间对齐/);
  assert.equal(run(files, ['--strict', '--glossary', 'terms.json']).status, 1);
});

test('project glossary does not flag inline code identifiers', () => {
  const { output } = run({
    'README.md': '## 用法\n\n使用 `跨流对轴` 字段读取配置。\n',
    'terms.json': JSON.stringify({ terms: [{ preferred: '跨流时间对齐', avoid: ['跨流对轴'] }] }),
  }, ['--glossary', 'terms.json']);
  assert.doesNotMatch(output, /term-preference/);
});

test('missing and malformed project glossary fail with a usage error', () => {
  assert.equal(run({ 'README.md': '## 用法\n\n读取配置。\n' }, ['--glossary']).status, 2);
  const result = run({ 'README.md': '## 用法\n\n读取配置。\n', 'terms.json': '{invalid' }, ['--glossary', 'terms.json']);
  assert.equal(result.status, 2);
  assert.match(result.output, /无法读取项目术语表/);
});

test('file placement is not this linter business', () => {
  const headings = ['架构', '设计', '模块', '状态机', '数据流', '测试', '验证', '覆盖', '排查', '重构'];
  const { output } = run({
    'README.md': headings.map((name) => `## ${name}\n\n内容一句。`).join('\n\n') + '\n',
  });
  assert.doesNotMatch(output, /readme-headings|zh-en-parity/);
});

test('a paragraph that carries five separate facts is reported once at its first line', () => {
  const body = '迁移不会随 API 启动自动运行。'
    + '升级旧库时先应用 0002，再让目标用户登录一次，建立个人工作区。'
    + '如果仍有未归属任务，应用 0003 前要设置三个归属变量和一个确认变量。'
    + '目标用户不匹配、被禁用或者没有工作区时，迁移失败。'
    + '迁移只把这些任务指派给那一个工作区，不猜测，也不拆分原来的共享数据。'
    + '已有任务、汇报内容和报告来源都会保留，旧报告的归属字段继续为空。'
    + '之后的 0004 到 0007 依次应用，把既有工作区标记为个人空间并回填 Owner 成员。'
    + '这些迁移不移动任务、汇报、评论、活动和密钥，也不更改已有的记录 ID。'
    + '回退时旧后端可能忽略归档字段，把已归档任务重新显示在当前列表里，所以回退版本必须保留归档过滤和工作区隔离。';
  const { output } = run({ 'README.md': `## 迁移\n\n${body}\n` });
  const hits = output.split('\n').filter((line) => line.includes('paragraph-length'));
  assert.equal(hits.length, 1);
  assert.match(hits[0], /^\s+3\s/);
});

test('a list of short bullets is not a long paragraph', () => {
  const bullets = ['收藏、目录历史和会话备注只存在本机 GUI', '最近目录只表示命令发了出去', 'SSH 目录按会话隔离', 'SSH 预设不存密码', 'WSL 预设不设置 Windows 启动目录']
    .map((item) => `- ${item}`).join('\n');
  const { output } = run({ 'README.md': `## 说明\n\n${bullets}\n` });
  assert.doesNotMatch(output, /paragraph-length/);
});

test('numbered steps are a list, not a long paragraph', () => {
  const steps = ['备份现有配置', '停止服务', '替换二进制', '运行迁移', '启动服务并检查健康端点', '验证旧会话仍然可以重连']
    .map((item, index) => `${index + 1}. ${item}，确认没有报错后再进入下一步。`).join('\n');
  const { output } = run({ 'README.md': `## 升级\n\n${steps}\n` });
  assert.doesNotMatch(output, /paragraph-length/);
});

test('a colon starts a new reading unit, so 结论：三条解释 is not one long sentence', () => {
  const line = '响应头有三个字段。超时时间是 30 秒，这是应用会话的默认值，配置在 Access 应用里修改，重启后仍然生效，不需要重新登录。';
  const long = '边界是：**已经处于回放状态的舞台**可以跳转，每个目标都要单独获得该源的锚点授权；**从直播进入回放**在界面里没有入口，内部事务也没有调用方。';
  const { output } = run({ 'README.md': `## 说明\n\n${line}\n\n${long}\n` });
  const hits = output.split('\n').filter((item) => item.includes('sentence-length'));
  assert.equal(hits.length, 0, 'the colon clause must be measured on its own');
});

test('a bullet with a colon is still one sentence for the bullet rule', () => {
  const { output } = run({
    'README.md': '## 功能\n\n- **专注模式**：隐藏工作区控件，只显示当前终端。\n',
  });
  assert.doesNotMatch(output, /bullet-sentences/);
});
