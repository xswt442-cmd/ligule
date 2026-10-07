// 键盘层那一份表的检查：跑 `node dev/hotkeys.check.mjs`。
import assert from 'node:assert/strict';
import { CURRENT, KEYMAP, actionOf, conflictsIn, defaultSpecs, formatKeys, isCapturing, isComposing, loadBindings, parseSpec, setCapturing, specOf } from '../src/hotkeys.ts';
import { insertMention, mentionToken } from '../src/mentions.ts';

// 认键与说键读的是同一份表（方案 6.1）：这一记按键落的是哪一个动作，与按钮上写的那一串字，一处改了另一处跟着改。
assert.equal(actionOf({ key: 'k', ctrlKey: true }, '窗口'), 'palette');
assert.equal(actionOf({ key: 'K', metaKey: true }, '窗口'), 'palette', 'Cmd 与 Ctrl 在这一层认成同一记修饰键');
assert.equal(actionOf({ key: 'b', ctrlKey: true }, '窗口'), 'sidebar');
assert.equal(actionOf({ key: 'c', ctrlKey: true, shiftKey: true }, '窗口'), 'copy-answer');
// 复制选中的文字、普通输入与没有修饰键的那一些都不该被窗口那一层接走。
assert.equal(actionOf({ key: 'c', ctrlKey: true }, '窗口'), null);
assert.equal(actionOf({ key: 'k', shiftKey: true }, '窗口'), null);
// Esc 在两个范围里落的是两件事：候选清单开着时收的是清单，都收完了才轮到打断这一轮。
assert.equal(actionOf({ key: 'Escape' }, '候选清单'), 'hide-candidate');
assert.equal(actionOf({ key: 'Escape' }, '窗口'), 'interrupt');
// 同一记 Enter 在输入坞是发送，在候选清单是选中：不同范围共用不算冲突，同范围撞了要报出来。
assert.equal(actionOf({ key: 'Enter' }, '输入坞'), 'send');
assert.equal(actionOf({ key: 'Enter' }, '候选清单'), 'pick-candidate');
assert.deepEqual(conflictsIn('输入坞', defaultSpecs()), []);
assert.deepEqual(conflictsIn('输入坞', { ...defaultSpecs(), newline: 'enter' }), [['send', 'newline']], '同一范围里两记键撞在一起要说得出是哪两条');
assert.equal(formatKeys('ctrl+shift+c'), 'Ctrl+Shift+C');
assert.equal(formatKeys('arrowup'), '↑');
assert.equal(formatKeys('escape'), 'Esc');
assert.equal(formatKeys('ctrl+'), 'ctrl+', '读不懂的写法原样交回，不编出一个键名');
assert.equal(specOf({ key: 'Control' }), null, '光按修饰键不是一记绑定');
// 表里每一条都要有键、有说法、有范围，且那串键认得回来：提示清单就是照着这一份表排的。
for (const [action, binding] of Object.entries(KEYMAP)) {
  assert.ok(binding.label !== '' && binding.view !== '', `${action} 要说得出做什么与落在哪一个范围`);
  assert.equal(actionOf({ key: binding.spec.split('+').at(-1), ...(binding.spec.includes('ctrl') ? { ctrlKey: true } : {}), ...(binding.spec.includes('shift') ? { shiftKey: true } : {}) }, binding.view), action, `${action} 的默认键认得回来`);
}
// 个人覆盖那一条路：读得开的落下、读不开的一条条报出来，认键与说键跟着一起换（方案 6.1）。
assert.equal(parseSpec('Ctrl+Shift+K'), 'ctrl+shift+k');
assert.equal(parseSpec('esc'), 'escape');
assert.equal(parseSpec('hyper+k'), null, '表里没有的那一个修饰键不猜');
assert.equal(parseSpec('ctrl+'), null, '缺一记键名不算一记键');
const loaded = loadBindings({ palette: 'ctrl+alt+p', 表里没有: 'ctrl+y' });
assert.equal(loaded.applied, 1);
assert.deepEqual(loaded.refused, ['表里没有（表里没有这一个动作）'], '名字对不上就说出来，不悄悄丢掉');
assert.equal(actionOf({ key: 'p', ctrlKey: true, altKey: true }, '窗口'), 'palette', '改过之后那一记键落的是开面板');
assert.equal(actionOf({ key: 'k', ctrlKey: true }, '窗口'), null, '原先那一记键不再落开面板');
assert.equal(formatKeys(CURRENT.palette), 'Ctrl+Alt+P', '按钮与提示上那串字跟着换');
const restored = loadBindings({});
assert.equal(restored.applied, 0, '整份退回默认之后那一张表是空的');
assert.equal(actionOf({ key: 'k', ctrlKey: true }, '窗口'), 'palette', '退回默认之后 Enter 那一条路照旧');
assert.equal(isCapturing(), false);
setCapturing(true);
assert.equal(isCapturing(), true, '录一记新键的那一段里，窗口这一层要知道自己该不接键');
setCapturing(false);
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
