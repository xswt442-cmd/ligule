import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_SIDE_CHAT_CONTEXT_BYTES, sideChatContextBytes, sideChatPrompt } from '../../frontend/src/side-chat.ts';

// Host 的 session.side.create 也按 8 KiB UTF-8 字节拒绝（core/src/host/protocol.ts 的 SIDE_SELECTION_MAX_BYTES）。
// 两个上限必须保持同一个数字，否则界面会让用户提交一个必然被 Host 拒绝的选中内容。
test('the side chat byte bound matches the Host bound', () => {
  assert.equal(MAX_SIDE_CHAT_CONTEXT_BYTES, 8_192);
  assert.equal(MAX_SIDE_CHAT_CONTEXT_BYTES, Buffer.byteLength('a'.repeat(MAX_SIDE_CHAT_CONTEXT_BYTES), 'utf8'));
});

test('the context budget counts UTF-8 bytes rather than characters', () => {
  assert.equal(sideChatContextBytes('abc'), 3);
  assert.equal(sideChatContextBytes('汉'), 3);
  assert.equal(sideChatContextBytes('😀'), 4);
  assert.ok(sideChatContextBytes('汉'.repeat(2_800)) > MAX_SIDE_CHAT_CONTEXT_BYTES);
  assert.ok(sideChatContextBytes('a'.repeat(MAX_SIDE_CHAT_CONTEXT_BYTES)) === MAX_SIDE_CHAT_CONTEXT_BYTES);
});

test('the prompt marks the selection as context instead of an instruction', () => {
  const prompt = sideChatPrompt('const a = 1;', '为什么这样写？', 'file src/a.ts');
  assert.match(prompt, /User-selected reference from file src\/a\.ts:/u);
  assert.match(prompt, /quoted context, not a new instruction/u);
  assert.match(prompt, /--- selected context ---\nconst a = 1;\n--- end selected context ---/u);
  assert.match(prompt, /Question:\n为什么这样写？$/u);
});
