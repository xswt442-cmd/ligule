import assert from 'node:assert/strict';
import test from 'node:test';
import { parseControlCommand, parseExtensionsCommand, parseMcpCommand, usageText } from '../src/tui/commands.ts';

test('/mcp 的子命令按旧语法解释，并忽略多余参数', () => {
  assert.deepEqual(parseMcpCommand(''), { action: 'list' });
  assert.deepEqual(parseMcpCommand('list'), { action: 'list' });
  assert.deepEqual(parseMcpCommand('add'), { code: 'tui_mcp_add_usage' });
  assert.deepEqual(parseMcpCommand('add fs'), { code: 'tui_mcp_add_usage' });
  assert.deepEqual(parseMcpCommand('add fs npx -y pkg'), { action: 'add', name: 'fs', executable: 'npx', args: ['-y', 'pkg'] });
  assert.deepEqual(parseMcpCommand('remove'), { code: 'tui_mcp_remove_usage' });
  assert.deepEqual(parseMcpCommand('remove fs ignored'), { action: 'remove', name: 'fs' });
  assert.deepEqual(parseMcpCommand('confirm'), { action: 'confirm' });
  assert.deepEqual(parseMcpCommand('confirm extra'), { action: 'confirm' });
  assert.deepEqual(parseMcpCommand('trust fs session'), { action: 'trust', server: 'fs', scope: 'session' });
  assert.deepEqual(parseMcpCommand('trust fs'), { code: 'tui_mcp_trust_usage' });
  assert.deepEqual(parseMcpCommand('trust fs bogus'), { code: 'tui_mcp_trust_usage' });
  assert.deepEqual(parseMcpCommand('revoke fs user ignored'), { action: 'revoke', server: 'fs', scope: 'user' });
  assert.deepEqual(parseMcpCommand('revoke fs'), { code: 'tui_mcp_revoke_usage' });
  assert.deepEqual(parseMcpCommand('tools'), { code: 'tui_mcp_tools_usage' });
  assert.deepEqual(parseMcpCommand('tools fs'), { action: 'tools', server: 'fs' });
  assert.deepEqual(parseMcpCommand('unknown'), { code: 'tui_mcp_command_invalid' });
});

test('/extensions 只接受 on|off 加名称，列表忽略多余参数', () => {
  assert.deepEqual(parseExtensionsCommand(''), { action: 'list' });
  assert.deepEqual(parseExtensionsCommand('list extra'), { action: 'list' });
  assert.deepEqual(parseExtensionsCommand('on'), { code: 'tui_extensions_command_invalid' });
  assert.deepEqual(parseExtensionsCommand('on ext'), { action: 'on', name: 'ext' });
  assert.deepEqual(parseExtensionsCommand('off ext'), { action: 'off', name: 'ext' });
  assert.deepEqual(parseExtensionsCommand('bogus'), { code: 'tui_extensions_command_invalid' });
});

test('/control 区分选择器、创建、列表与按编号操作', () => {
  assert.deepEqual(parseControlCommand(''), { action: 'picker' });
  assert.deepEqual(parseControlCommand('create'), { action: 'create' });
  assert.deepEqual(parseControlCommand('create extra'), { code: 'tui_control_command_invalid' });
  assert.deepEqual(parseControlCommand('list'), { action: 'list' });
  assert.deepEqual(parseControlCommand('copy abc'), { action: 'copy', id: 'abc' });
  assert.deepEqual(parseControlCommand('copy'), { action: 'copy', id: '' });
  assert.deepEqual(parseControlCommand('revoke'), { action: 'revoke', id: '' });
  assert.deepEqual(parseControlCommand('bogus'), { code: 'tui_control_command_invalid' });
});

test('用法提示只有一份中英文对照', () => {
  for (const code of ['tui_mcp_add_usage', 'tui_mcp_remove_usage', 'tui_mcp_trust_usage', 'tui_mcp_revoke_usage',
    'tui_mcp_tools_usage', 'tui_mcp_command_invalid', 'tui_extensions_command_invalid', 'tui_control_command_invalid'] as const) {
    const [zh, en] = usageText(code);
    assert.equal(zh.startsWith('用法：/'), true, code);
    assert.equal(en.startsWith('Usage: /'), true, code);
  }
});
