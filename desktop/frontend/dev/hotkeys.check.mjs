// 键盘层那一个判断的检查：跑 `node dev/hotkeys.check.mjs`。
import assert from 'node:assert/strict';
import { hotkeyOf, isComposing } from '../src/hotkeys.ts';

assert.equal(hotkeyOf({ key: 'k', ctrlKey: true }), 'palette');
assert.equal(hotkeyOf({ key: 'K', metaKey: true }), 'palette');
assert.equal(hotkeyOf({ key: 'b', ctrlKey: true }), 'sidebar');
assert.equal(hotkeyOf({ key: 'c', ctrlKey: true, shiftKey: true }), 'copy');
// 复制选中的文字、普通输入与没有修饰键的那一些都不该被接走。
assert.equal(hotkeyOf({ key: 'c', ctrlKey: true }), null);
assert.equal(hotkeyOf({ key: 'Escape' }), null);
assert.equal(hotkeyOf({ key: 'k', shiftKey: true }), null);
// 输入法组合期间的那一格：`isComposing` 是标准写法，229 是各浏览器在组合中一贯交回的 keyCode。
assert.equal(isComposing({ isComposing: true, key: 'Enter' }), true);
assert.equal(isComposing({ keyCode: 229, key: 'Process' }), true);
assert.equal(isComposing({ key: 'Escape' }), false);
assert.equal(isComposing({ isComposing: false, keyCode: 27, key: 'Escape' }), false, 'Esc 自己不该被当成组合按键，否则面板与打断这一轮都关不掉了');
console.log('桌面前端的按键检查通过');
