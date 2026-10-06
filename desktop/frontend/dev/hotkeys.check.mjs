// 键盘层那一个判断的检查：跑 `node dev/hotkeys.check.mjs`。
import assert from 'node:assert/strict';
import { hotkeyOf } from '../src/hotkeys.ts';

assert.equal(hotkeyOf({ key: 'k', ctrlKey: true }), 'palette');
assert.equal(hotkeyOf({ key: 'K', metaKey: true }), 'palette');
assert.equal(hotkeyOf({ key: 'b', ctrlKey: true }), 'sidebar');
assert.equal(hotkeyOf({ key: 'c', ctrlKey: true, shiftKey: true }), 'copy');
// 复制选中的文字、普通输入与没有修饰键的那一些都不该被接走。
assert.equal(hotkeyOf({ key: 'c', ctrlKey: true }), null);
assert.equal(hotkeyOf({ key: 'Escape' }), null);
assert.equal(hotkeyOf({ key: 'k', shiftKey: true }), null);
console.log('桌面前端的按键检查通过');
