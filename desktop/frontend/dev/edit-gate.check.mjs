// 离开之前那一份拦路的检查：跑 `node dev/edit-gate.check.mjs`。
// 这里量的是「哪几栏还攥着没写进配置的编辑、离开时拦不拦」；那一张卡片怎么画、按下去走不走，在真壳那一趟（审阅 G2）。
import assert from 'node:assert/strict';
import { holdReasons, report } from '../src/edit-gate.ts';

// 一句都没有：不画一张空卡片，父层那一条直接走。
assert.deepEqual(holdReasons({}), []);
assert.deepEqual(holdReasons({ model: '', rules: '' }), [], '空的那一句不算攥着');

// 各报各的：模型那一栏的草稿、规则那一栏的草稿，两句都列出来，谁都没盖掉谁。
const both = report(report({}, 'model', '「模型与端点」里的「服务地址」还没保存'), 'rules', '「审批规则」里有一条新规则还没保存');
assert.deepEqual(holdReasons(both), [
  '「模型与端点」里的「服务地址」还没保存',
  '「审批规则」里有一条新规则还没保存',
]);

// 收回与换掉：报同一格第二次是换掉那一句，报空串是把这一格整条清掉，别的那一栏不受牵连。
const changed = report(both, 'model', '「模型与端点」正在写配置文件，这一笔的答复还没读回来');
assert.deepEqual(holdReasons(changed), [
  '「模型与端点」正在写配置文件，这一笔的答复还没读回来',
  '「审批规则」里有一条新规则还没保存',
]);
const cleared = report(changed, 'model', '');
assert.deepEqual(holdReasons(cleared), ['「审批规则」里有一条新规则还没保存']);
assert.deepEqual(Object.hasOwn(cleared, 'model'), false, '收回之后不留一条空的');

// 内容没变时交回同一个对象：栏里每画一次就报一次，不该为此多绕一圈重画。
assert.equal(report(both, 'model', '「模型与端点」里的「服务地址」还没保存'), both, '重复报同一句不该造出新的表');
assert.equal(report(both, 'keys', ''), both, '没报过的格子收回一句也不该造出新的表');

console.log('桌面前端的离开拦路检查通过');
