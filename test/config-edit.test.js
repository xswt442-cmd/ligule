// 配置写入侧那份纯逻辑与那一次落盘的检查（方案 7.2）：保住注释、顺序与换行形状，撞了版本就报。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'smol-toml';
import { EDITABLE, configVersion, editTomlValue, editableField, encodeValue, writeConfigField } from '../dist/kernel/config-edit.js';

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
});

test('a value this route cannot read is refused without touching a byte', () => {
  const array = '[model]\nmodel = "a"\nrules = [\n  "one",\n]\n';
  assert.throws(() => editTomlValue(array, ['model', 'rules'], '"x"'), (error) => error.code === 'config_edit_shape_unsupported');
  const multiline = '[model]\nabout = """\n两行\n"""\n';
  assert.throws(() => editTomlValue(multiline, ['model', 'about'], '"x"'), (error) => error.code === 'config_edit_shape_unsupported');
  const inline = '[model]\nextra = { api = "messages" }\n';
  assert.throws(() => editTomlValue(inline, ['model', 'extra'], '"x"'), (error) => error.code === 'config_edit_shape_unsupported');
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
    const first = await writeConfigField(file, 'model.model', '第一次', configVersion(SAMPLE));
    assert.equal(first.created, false);
    assert.equal(parse(await readFile(file, 'utf8')).model.model, '第一次');
    await assert.rejects(readFile(`${file}.tmp`), (error) => error.code === 'ENOENT', '临时文件改名走了，不留在原地');

    // 别人（另一个进程或人自己开的编辑器）在这之后改过：报冲突，那一份改动留着。
    const outside = SAMPLE.replace('gpt-4o', '别人写的');
    await writeFile(file, outside, 'utf8');
    await assert.rejects(
      () => writeConfigField(file, 'model.model', '我要写的', first.version),
      (error) => error.code === 'config_version_stale',
    );
    assert.equal(parse(await readFile(file, 'utf8')).model.model, '别人写的', '冲突那一次一个字都没写');

    const again = await writeConfigField(file, 'model.api', 'chat-completions', configVersion(outside));
    assert.equal(again.version, configVersion(await readFile(file, 'utf8')));
    assert.equal(parse(await readFile(file, 'utf8')).model.api, 'chat-completions');

    // 那份文件不在时写一次：版本是空串，缺的目录一起补出来，新建的那一份是有效配置。
    const fresh = join(directory, 'new', 'config.toml');
    const createdFile = await writeConfigField(fresh, 'model.model', '新建里的', '');
    assert.equal(createdFile.created, true);
    assert.equal(parse(await readFile(fresh, 'utf8')).model.model, '新建里的');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
