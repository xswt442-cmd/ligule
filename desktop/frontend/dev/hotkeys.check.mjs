// 键盘层那一个判断的检查：跑 `node dev/hotkeys.check.mjs`。
import assert from 'node:assert/strict';
import { hotkeyOf, isComposing } from '../src/hotkeys.ts';
import { insertMention, mentionToken } from '../src/mentions.ts';

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
// `@` 那一段路径引用：与终端那一侧同一条规则，两处认出来的东西不该不一样（方案 5.3）。
assert.deepEqual(mentionToken('先看 @notes/rea', 13), { start: 3, text: 'notes/rea' });
assert.deepEqual(mentionToken('@a', 2), { start: 0, text: 'a' });
assert.equal(mentionToken('邮箱是me@li', 8), null, '紧贴在字后面的 @ 不是路径引用');
assert.equal(mentionToken('@notes/rea 后面还有字', 8), null, '笔落在一段中间时不替换');
assert.deepEqual(insertMention('先看 @rea', 7, 3, 'notes/readings-3.md'), { draft: '先看 @notes/readings-3.md ', caret: 24 });
console.log('桌面前端的按键检查通过');
