// 检查快捷键映射、按键显示和输入行为。
import assert from 'node:assert/strict';
import { CURRENT, KEYMAP, actionOf, conflictsIn, defaultSpecs, formatKeys, isCapturing, isComposing, loadBindings, parseSpec, setCapturing, specOf } from '../src/hotkeys.ts';
import { insertMention, mentionToken } from '../src/mentions.ts';
import { mergeQueueIntoDraft } from '../src/settings.ts';

// 按键处理与界面显示共用同一份快捷键定义。
assert.equal(actionOf({ key: 'k', ctrlKey: true }, '窗口'), 'palette');
assert.equal(actionOf({ key: 'K', metaKey: true }, '窗口'), 'palette', 'Cmd 与 Ctrl 在这一层认成同一记修饰键');
assert.equal(actionOf({ key: 'b', ctrlKey: true }, '窗口'), 'sidebar');
assert.equal(actionOf({ key: 'c', ctrlKey: true, shiftKey: true }, '窗口'), 'copy-answer');
// 未匹配的快捷键应交给浏览器和当前输入控件处理。
assert.equal(actionOf({ key: 'c', ctrlKey: true }, '窗口'), null);
assert.equal(actionOf({ key: 'k', shiftKey: true }, '窗口'), null);
// 候选列表打开时，Escape 先关闭列表；列表关闭后才中断当前轮次。
assert.equal(actionOf({ key: 'Escape' }, '候选清单'), 'hide-candidate');
assert.equal(actionOf({ key: 'Escape' }, '窗口'), 'interrupt');
// 同一个按键可在不同界面区域执行不同动作，但不能在同一区域绑定多个动作。
assert.equal(actionOf({ key: 'Enter' }, '输入坞'), 'send');
assert.equal(actionOf({ key: 'Enter' }, '候选清单'), 'pick-candidate');
assert.deepEqual(conflictsIn('输入坞', defaultSpecs()), []);
assert.deepEqual(conflictsIn('输入坞', { ...defaultSpecs(), newline: 'enter' }), [['send', 'newline']], '同一范围里两记键撞在一起要说得出是哪两条');
assert.equal(formatKeys('ctrl+shift+c'), 'Ctrl+Shift+C');
assert.equal(formatKeys('arrowup'), '↑');
assert.equal(formatKeys('escape'), 'Esc');
assert.equal(formatKeys('ctrl+'), 'ctrl+', '读不懂的写法原样交回，不编出一个键名');
assert.equal(specOf({ key: 'Control' }), null, '光按修饰键不是一记绑定');
// 每个默认绑定都应包含动作说明和作用范围，且能正确解析回对应动作。
for (const [action, binding] of Object.entries(KEYMAP)) {
  assert.ok(binding.label !== '' && binding.view !== '', `${action} 要说得出做什么与落在哪一个范围`);
  assert.equal(actionOf({ key: binding.spec.split('+').at(-1), ...(binding.spec.includes('ctrl') ? { ctrlKey: true } : {}), ...(binding.spec.includes('shift') ? { shiftKey: true } : {}) }, binding.view), action, `${action} 的默认键认得回来`);
}
// 加载用户覆盖项时，应应用有效绑定并逐项报告无效绑定。
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
// 输入法组合期间的按键不应触发快捷键；兼容浏览器使用的 229 keyCode。
assert.equal(isComposing({ isComposing: true, key: 'Enter' }), true);
assert.equal(isComposing({ keyCode: 229, key: 'Process' }), true);
assert.equal(isComposing({ key: 'Escape' }), false);
assert.equal(isComposing({ isComposing: false, keyCode: 27, key: 'Escape' }), false, 'Esc 自己不该被当成组合按键，否则面板与打断这一轮都关不掉了');
// 桌面端路径引用应与终端使用相同的解析规则。
assert.deepEqual(mentionToken('先看 @notes/rea', 13), { start: 3, text: 'notes/rea' });
assert.deepEqual(mentionToken('@a', 2), { start: 0, text: 'a' });
assert.equal(mentionToken('邮箱是me@li', 8), null, '紧贴在字后面的 @ 不是路径引用');
assert.equal(mentionToken('@notes/rea 后面还有字', 8), null, '笔落在一段中间时不替换');
assert.deepEqual(insertMention('先看 @rea', 7, 3, 'notes/readings-3.md'), { draft: '先看 @notes/readings-3.md ', caret: 24 });
// 重连后将排队内容按原顺序接到草稿末尾；草稿为空时不添加空行。
assert.equal(mergeQueueIntoDraft('先前的一句', ['第二句', '第三句']), '先前的一句\n\n第二句\n\n第三句');
assert.equal(mergeQueueIntoDraft('', ['第一条', '第二条']), '第一条\n\n第二条', '空草稿时不留一个前导空行');
assert.equal(mergeQueueIntoDraft('', []), '', '没有排着的句时草稿不动');
console.log('桌面前端的按键检查通过');
