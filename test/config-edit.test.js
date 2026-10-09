// 配置写入侧那份纯逻辑与那一次落盘的检查（方案 7.2）：保住注释、顺序与换行形状，撞了版本就报。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'smol-toml';
import lockfile from 'proper-lockfile';
import {
  EDITABLE,
  checkedRule,
  configVersion,
  editRuleTable,
  editTomlValue,
  editableField,
  encodeValue,
  rulesOfLayer,
  writeConfigField,
} from '../dist/kernel/config-edit.js';

const field = (id) => EDITABLE[id];
const apply = (text, id, value) => editTomlValue(text, field(id).path, encodeValue(field(id), value).literal).text;

const SAMPLE = `# 使用者默认
[model]
api = "messages" # 线上形状
model = "gpt-4o"

[limits]
contextTokens = 200000
`;

test('a config value changes in place and everything else stays where it was', () => {
  const edited = apply(SAMPLE, 'model.model', '新模型名');
  assert.ok(edited.includes('model = "新模型名"'), edited);
  assert.ok(edited.includes('api = "messages" # 线上形状'), '行尾那句注释留着');
  assert.ok(edited.includes('# 使用者默认'), '整行的注释留着');
  assert.ok(edited.indexOf('[model]') < edited.indexOf('[limits]'), '键的顺序不动');
  assert.equal(parse(edited).model.model, '新模型名');
  assert.equal(parse(edited).limits.contextTokens, 200000, '没编辑的字段还是原值');
  assert.notEqual(editTomlValue(SAMPLE, ['model', 'model'], '"gpt-4o"').created, true);
});

test('a missing key is added inside its own table, a missing table at the end', () => {
  const added = apply('[model]\napi = "messages"\n\n[policy]\ntier = "ask"\n', 'model.model', '甲');
  assert.equal(added, '[model]\napi = "messages"\nmodel = "甲"\n\n[policy]\ntier = "ask"\n');
  const whole = apply('[limits]\ncontextTokens = 1\n', 'model.model', '乙');
  assert.equal(whole, '[limits]\ncontextTokens = 1\n\n[model]\nmodel = "乙"\n');
  assert.equal(editTomlValue('', ['model', 'model'], '"丙"').text, '[model]\nmodel = "丙"\n');
});

test('a root-level dotted key is the same thing as the one inside that table', () => {
  const edited = apply('model.model = "old" # 顶层写法\n\n[limits]\ncontextTokens = 1\n', 'model.model', 'new');
  assert.ok(edited.includes('model.model = "new" # 顶层写法'), edited);
  assert.equal(parse(edited).model.model, 'new');
});

test('mixed line endings and a CRLF file keep the shape each line already had', () => {
  const crlf = apply('[model]\r\nmodel = "old"\r\n', 'model.model', 'new');
  assert.equal(crlf, '[model]\r\nmodel = "new"\r\n');
  assert.equal(parse(crlf).model.model, 'new');
  // 同一份文件里 CRLF 与 LF 混着：改的那一行保住它自己那个换行，别的行一个字不变。
  const mixed = apply('[model]\r\nmodel = "old"\napi = "messages"\r\n', 'model.model', 'new');
  assert.equal(mixed, '[model]\r\nmodel = "new"\napi = "messages"\r\n');
  assert.equal(parse(mixed).model.api, 'messages', '没编辑的那一行连它的换行都没动');
});

test('a value this route cannot read is refused, and the shape is named', () => {
  const array = '[model]\nmodel = "a"\nrules = [\n  "one",\n]\n';
  assert.throws(() => editTomlValue(array, ['model', 'rules'], '"x"'), (error) => error.code === 'config_edit_shape_unsupported' && /an array/.test(error.detail));
  const multiline = '[model]\nabout = """\n两行\n"""\n';
  assert.throws(() => editTomlValue(multiline, ['model', 'about'], '"x"'), (error) => error.code === 'config_edit_shape_unsupported' && /a multi-line string/.test(error.detail));
  const inline = '[model]\nextra = { api = "messages" }\n';
  assert.throws(() => editTomlValue(inline, ['model', 'extra'], '"x"'), (error) => error.code === 'config_edit_shape_unsupported' && /an inline table/.test(error.detail));
});

// 多行字符串的那几行正文只是正文：里面长得像键行与表头的东西都不算结构，改的要落在表里那一条上。
test('a multi-line string body is not read as a key line or a table header', () => {
  const body = editTomlValue('[model]\nabout = """\nmodel = "正文里的这一行"\n"""\nmodel = "表里的那一条"\n', ['model', 'model'], '"新值"');
  assert.equal(body.text, '[model]\nabout = """\nmodel = "正文里的这一行"\n"""\nmodel = "新值"\n');
  assert.equal(parse(body.text).model.about, 'model = "正文里的这一行"\n', '那一段正文一个字没动');

  const header = editTomlValue('[model]\nabout = """\n[limits]\nstill inside\n"""\nmodel = "old"\n', ['model', 'model'], '"new"');
  assert.equal(parse(header.text).model.model, 'new');
  assert.equal(parse(header.text).model.about, '[limits]\nstill inside\n', '那一段里的表头形状没有切断这一段');
  assert.ok(header.text.includes('[limits]'), '那一句还留在正文里');

  // 那一张表里根本没有这一条时，补的行落在写完的那一条键之后，不掉进还没闭下来的正文里。
  const added = editTomlValue('[model]\nabout = """\n两行\n"""\n', ['model', 'model'], '"补的"');
  assert.equal(added.text, '[model]\nmodel = "补的"\nabout = """\n两行\n"""\n');
  assert.equal(parse(added.text).model.model, '补的');
});

// 键名与表名两侧的空白、带引号的写法都是合法 TOML：那一条就是要改的那一条，原写法保住。
test('a quoted key and a spaced or quoted table header are the same key', () => {
  assert.equal(editTomlValue('[model]\n"model" = "old"\n', ['model', 'model'], '"new"').text, '[model]\n"model" = "new"\n');
  assert.equal(editTomlValue('[model]\n\'model\' = "old"\n', ['model', 'model'], '"new"').text, '[model]\n\'model\' = "new"\n');
  assert.equal(parse(editTomlValue('["model"]\nmodel = "old"\n', ['model', 'model'], '"new"').text).model.model, 'new');
  assert.equal(parse(editTomlValue('[ model ]\nmodel = "old"\n', ['model', 'model'], '"new"').text).model.model, 'new');
  assert.equal(editTomlValue('[ model ]\nmodel = "old"\n', ['model', 'model'], '"new"').created, false, '那一张表已经在了，不是补一张新的');
  // 顶层那一条点号键两侧的空格也一样认下来。
  assert.equal(parse(editTomlValue('model . model = "old"\n', ['model', 'model'], '"new"').text).model.model, 'new');
});

test('a key with the same name in another table is not the one being changed', () => {
  const edited = apply('[model]\nmodel = "在这里改"\n\n[other]\nmodel = "这一份不动"\n', 'model.model', '新');
  assert.equal(parse(edited).model.model, '新');
  assert.equal(parse(edited).other.model, '这一份不动');
});

test('each field only takes a value of its own shape', () => {
  assert.equal(encodeValue(field('model.api'), 'chat-completions').literal, '"chat-completions"');
  assert.throws(() => encodeValue(field('model.api'), 'openai'), (error) => error.code === 'config_field_value');
  // 带查询的地址是可以写的（那是那一家端点的路径形状），地址里塞凭据不收（D13）。
  assert.equal(encodeValue(field('model.baseURL'), 'https://a.example.com:443/v1?api=k').value, 'https://a.example.com:443/v1?api=k');
  assert.throws(() => encodeValue(field('model.baseURL'), 'https://user:pass@a.example.com/v1'), (error) => /credentials/.test(error.detail), '凭据不写进配置（D13）');
  assert.throws(() => encodeValue(field('model.baseURL'), 'a.example.com/v1'), (error) => error.code === 'config_field_value');
  assert.equal(encodeValue(field('model.baseURL'), ' http://127.0.0.1:8080/v1 ').value, 'http://127.0.0.1:8080/v1');
  assert.throws(() => encodeValue(field('model.apiKeyEnv'), 'LIGULE KEY'), (error) => error.code === 'config_field_value');
  assert.throws(() => encodeValue(field('model.model'), '   '), (error) => error.code === 'config_field_value');
  assert.throws(() => editableField('model.unknown'), (error) => error.code === 'config_field_unknown');
  // 引号与反斜杠走 TOML 基本串那一套转义，值里带着它们也不改行形状。
  assert.equal(encodeValue(field('model.model'), 'a"b\\c').literal, '"a\\"b\\\\c"');
});

test('the write needs the version it read, lands atomically and reports the new one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-config-'));
  const file = join(directory, 'config.toml');
  try {
    await writeFile(file, SAMPLE, 'utf8');
    const first = await writeConfigField(file, { field: 'model.model', value: '第一次', version: configVersion(SAMPLE) });
    assert.equal(first.created, false);
    assert.equal(parse(await readFile(file, 'utf8')).model.model, '第一次');
    await assert.rejects(readFile(`${file}.tmp`), (error) => error.code === 'ENOENT', '临时文件改名走了，不留在原地');

    // 别人（另一个进程或人自己开的编辑器）在这之后改过：报冲突，那一份改动留着。
    const outside = SAMPLE.replace('gpt-4o', '别人写的');
    await writeFile(file, outside, 'utf8');
    await assert.rejects(
      () => writeConfigField(file, { field: 'model.model', value: '我要写的', version: first.version }),
      (error) => error.code === 'config_version_stale',
    );
    assert.equal(parse(await readFile(file, 'utf8')).model.model, '别人写的', '冲突那一次一个字都没写');

    const again = await writeConfigField(file, { field: 'model.api', value: 'chat-completions', version: configVersion(outside) });
    assert.equal(again.version, configVersion(await readFile(file, 'utf8')));
    assert.equal(parse(await readFile(file, 'utf8')).model.api, 'chat-completions');

    // 那份文件不在时写一次：版本是空串，缺的目录一起补出来，新建的那一份是有效配置。
    const fresh = join(directory, 'new', 'config.toml');
    const createdFile = await writeConfigField(fresh, { field: 'model.model', value: '新建里的', version: '' });
    assert.equal(createdFile.created, true);
    assert.equal(parse(await readFile(fresh, 'utf8')).model.model, '新建里的');

    // 档位那一条标量走的是同一条写入路。
    const tier = await writeConfigField(file, { field: 'policy.mode', value: 'auto', version: configVersion(await readFile(file, 'utf8')) });
    assert.equal(tier.created, true, '那一份文件里原来没有 [policy]，补一张表');
    assert.equal(parse(await readFile(file, 'utf8')).policy.mode, 'auto');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const RULES = `# 使用者默认
[policy]
mode = "ask" # 逐次问人

# 读文件不用问
[[policy.rules]]
tool = "read"
decision = "allow"

# 这一条只放行看状态
[[policy.rules]]
tool = "exec"
match = "git status*"
decision = "allow"
reason = "只读的那一条"

[limits]
contextTokens = 200000
`;

const readRules = (text) => rulesOfLayer(parse(text));

test('adding a rule lands at the end of that table, before the comment belonging to the next one', () => {
  const edited = editRuleTable(RULES, 'add', 0, { tool: 'find', decision: 'allow' });
  assert.equal(edited.created, false);
  const rules = readRules(edited.text);
  assert.equal(rules.length, 3);
  assert.deepEqual(rules[2], { tool: 'find', decision: 'allow' });
  // 表之外的字节一个不动：整行的注释、行尾的注释、下面那张表与键的顺序都在原地。
  assert.ok(edited.text.includes('# 使用者默认\n'), '文件头上那句注释留着');
  assert.ok(edited.text.includes('mode = "ask" # 逐次问人'), '行尾注释留着');
  assert.ok(edited.text.indexOf('[limits]') > edited.text.indexOf('tool = "find"'), '新块落在下一张表之前');
  assert.equal(parse(edited.text).limits.contextTokens, 200000);
});

test('changing one key of a rule keeps the other lines and drops the key the new rule does not carry', () => {
  const edited = editRuleTable(RULES, 'update', 1, { tool: 'exec', decision: 'deny', reason: '写之前先问' });
  const rules = readRules(edited.text);
  assert.deepEqual(rules[1], { tool: 'exec', decision: 'deny', reason: '写之前先问' }, 'match 这一行跟着新规则去掉');
  assert.deepEqual(rules[0], { tool: 'read', decision: 'allow' }, '别的那一项不动');
  assert.ok(edited.text.includes('# 读文件不用问'), '别的那一项头上的注释留着');
  assert.ok(edited.text.includes('decision = "deny"'), edited.text);
});

test('adding a key that the rule did not have appends it after the last key line', () => {
  const edited = editRuleTable(RULES, 'update', 0, { tool: 'read', decision: 'allow', match: 'src/**', reason: '读源码' });
  const rules = readRules(edited.text);
  assert.deepEqual(rules[0], { tool: 'read', match: 'src/**', decision: 'allow', reason: '读源码' });
  assert.ok(/# 这一条只放行看状态/.test(edited.text), '下一项的注释仍在');
});

test('removing a rule takes the comment attached to it and leaves the one attached to its neighbour', () => {
  const edited = editRuleTable(RULES, 'remove', 1);
  assert.equal(readRules(edited.text).length, 1);
  assert.ok(!edited.text.includes('这一条只放行看状态'), '贴着自己头上的那句注释一起删掉');
  assert.ok(edited.text.includes('# 读文件不用问'), '邻居的注释留着');
  assert.ok(edited.text.includes('[limits]'), edited.text);
});

// 一条语句的多行正文跟着那一行键一起算：只删头一行会把正文丢在原地，那一份文件就读不回 TOML 了。
test('a rule statement whose value is a multi-line string is dropped whole', () => {
  const text = '[[policy.rules]]\ntool = "read"\nreason = """\ndecision = "deny"\n"""\n';
  const edited = editRuleTable(text, 'update', 0, { tool: 'read', decision: 'allow' });
  assert.equal(edited.text, '[[policy.rules]]\ntool = "read"\ndecision = "allow"\n');
  assert.deepEqual(readRules(edited.text), [{ tool: 'read', decision: 'allow' }]);
  // 反过来要把那一条正文换成一行值：这一条路只换得上本行闭得下来的值，报出形状且不落笔。
  assert.throws(() => editRuleTable(text, 'update', 0, { tool: 'read', decision: 'allow', reason: '一句' }),
    (error) => error.code === 'config_edit_shape_unsupported' && /a multi-line string/.test(error.detail));
  // 宿主持有之外的键那一行也带着一段正文：整条留着，补的键落在它前面。
  const owned = editRuleTable('[[policy.rules]]\ntool = "read"\ndecision = "allow"\nowner = """\n两句\n"""\n', 'update', 0, { tool: 'read', decision: 'allow', match: 'git *' });
  assert.equal(owned.text, '[[policy.rules]]\ntool = "read"\ndecision = "allow"\nmatch = "git *"\nowner = """\n两句\n"""\n');
  assert.equal(parse(owned.text).policy.rules[0].owner, '两句\n');
});

test('a key the host does not own inside a rule is left where it is', () => {
  const edited = editRuleTable('[[policy.rules]]\ntool = "read"\ndecision = "allow"\nowner = "另一个人写的"\n', 'update', 0, { tool: 'read', decision: 'deny' });
  assert.ok(edited.text.includes('owner = "另一个人写的"'), edited.text);
  assert.deepEqual({ ...parse(edited.text).policy.rules[0] }, { tool: 'read', decision: 'deny', owner: '另一个人写的' });
});

// 那张表只以数组表存在时补的标量落在那几段之前：先 `[[a.b]]` 再声明 `[a]` 不是合法形状（第 121、122 步在真窗口里查出来的）。
test('a scalar added while the table exists only as an array of tables lands above those blocks', () => {
  const edited = editTomlValue('[[policy.rules]]\ntool = "read"\ndecision = "allow"\n', ['policy', 'mode'], '"ask"');
  assert.equal(edited.text, '[policy]\nmode = "ask"\n\n[[policy.rules]]\ntool = "read"\ndecision = "allow"\n');
  assert.equal(parse(edited.text).policy.mode, 'ask');
  assert.equal(parse(edited.text).policy.rules.length, 1);
  const commented = editTomlValue('# 让模型自己读\n[[policy.rules]]\ntool = "read"\ndecision = "allow"\n', ['policy', 'mode'], '"auto"');
  assert.ok(commented.text.startsWith('[policy]\nmode = "auto"\n\n# 让模型自己读\n[[policy.rules]]'), '那句注释仍说的是下面那一段：' + commented.text);
});

test('a rule index this file does not have is said plainly, and an empty file gets the table', () => {
  assert.throws(() => editRuleTable(RULES, 'update', 9, { tool: 'read', decision: 'allow' }), (error) => error.code === 'config_rule_index');
  assert.equal(editRuleTable('', 'add', 0, { tool: 'read', decision: 'allow' }).text, '[[policy.rules]]\ntool = "read"\ndecision = "allow"\n');
});

test('the rule shape is owned by the host: unknown keys, empty values and a wrong decision are refused', () => {
  assert.deepEqual(checkedRule({ tool: 'read', decision: 'allow', match: 'a*' }), { tool: 'read', decision: 'allow', match: 'a*' });
  for (const bad of [
    { tool: 'read' },
    { tool: 'read', decision: 'maybe' },
    { tool: ' ', decision: 'allow' },
    { tool: 'read', decision: 'allow', pattern: 'a*' },
    { tool: 'read', decision: 'allow', match: '' },
    'read',
  ]) {
    assert.throws(() => checkedRule(bad), (error) => error.code === 'config_rule_invalid', JSON.stringify(bad));
  }
});

test('the rule table writes through the same lock, version check and read-back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-rules-'));
  const file = join(directory, 'config.local.toml');
  try {
    await writeFile(file, RULES, 'utf8');
    const version = configVersion(RULES);
    const added = await writeConfigField(file, {
      field: 'policy.rules',
      op: 'add',
      rule: { tool: 'search', decision: 'deny', reason: '这一台机器上不让搜' },
      version,
    });
    assert.equal(added.rules.length, 3);
    assert.deepEqual(readRules(await readFile(file, 'utf8'))[2], { tool: 'search', decision: 'deny', reason: '这一台机器上不让搜' });

    await assert.rejects(
      () => writeConfigField(file, { field: 'policy.rules', op: 'remove', index: 0, version }),
      (error) => error.code === 'config_version_stale',
      '旧版本那一次不落笔',
    );
    const removed = await writeConfigField(file, {
      field: 'policy.rules',
      op: 'remove',
      index: 0,
      version: added.version,
    });
    assert.equal(removed.rules.length, 2);
    assert.deepEqual(removed.rules[0], { tool: 'exec', match: 'git status*', decision: 'allow', reason: '只读的那一条' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// 写法不同但都是合法 TOML 的那两份文件走同一条落盘路：引号键保住自己的引号，混着的换行保住每一行那一个。
test('a quoted key lands in place through the write route', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-quoted-'));
  const file = join(directory, 'config.toml');
  const original = '[ model ]\n"model" = "gpt-4o" # 那一家的名字\napi = "messages"\r\napiKeyEnv = \'LIGULE_KEY\'\r\n';
  try {
    await writeFile(file, original, 'utf8');
    const first = await writeConfigField(file, { field: 'model.model', value: '新模型名', version: configVersion(original) });
    assert.equal(first.created, false, '那一张表已经在了');
    assert.equal(first.version, configVersion(await readFile(file, 'utf8')));
    const onDisk = await readFile(file, 'utf8');
    assert.equal(onDisk, '[ model ]\n"model" = "新模型名" # 那一家的名字\napi = "messages"\r\napiKeyEnv = \'LIGULE_KEY\'\r\n');
    assert.equal(parse(onDisk).model.api, 'messages', '没编辑的那几行连换行都没动');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// 两份写入同时到达时后到那一份不排队也不覆盖：说出锁在那里，那一份文件一个字不动。
test('a file another writer holds is refused while that lock is active', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-lock-'));
  const file = join(directory, 'config.toml');
  try {
    await writeFile(file, SAMPLE, 'utf8');
    const held = await lockfile.lock(file, { realpath: false, lockfilePath: `${file}.lock`, stale: 10_000, update: 2_000, retries: 0 });
    try {
      await assert.rejects(
        () => writeConfigField(file, { field: 'model.model', value: '第二个写入者', version: configVersion(SAMPLE) }),
        (error) => error.code === 'config_locked',
      );
      assert.equal(parse(await readFile(file, 'utf8')).model.model, 'gpt-4o', '锁在那里的那一次一个字都没写');
    } finally {
      await held();
    }
    const after = await writeConfigField(file, { field: 'model.model', value: '锁放了才写', version: configVersion(SAMPLE) });
    assert.equal(after.created, false);
    assert.equal(parse(await readFile(file, 'utf8')).model.model, '锁放了才写');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
