// 检查未保存的编辑是否会阻止用户离开设置页面。
import assert from 'node:assert/strict';
import { holdReasons, report } from '../../src/edit-gate.ts';

// 没有未保存内容时，不应产生阻止离开的原因。
assert.deepEqual(holdReasons({}), []);
assert.deepEqual(holdReasons({ model: '', rules: '' }), [], '空的那一句不算攥着');

// 不同设置分区的未保存内容应分别保留。
const both = report(report(report({}, 'model', '「模型与端点」里的「服务地址」还没保存'), 'rules', '「审批规则」里有一条新规则还没保存'), 'permissions', '本会话权限更改尚未应用');
assert.deepEqual(holdReasons(both), [
  '「模型与端点」里的「服务地址」还没保存',
  '「审批规则」里有一条新规则还没保存',
  '本会话权限更改尚未应用',
]);

// 更新或清除一个分区的原因时，应保留其他分区的状态。
const changed = report(both, 'model', '「模型与端点」正在写配置文件，这一笔的答复还没读回来');
assert.deepEqual(holdReasons(changed), [
  '「模型与端点」正在写配置文件，这一笔的答复还没读回来',
  '「审批规则」里有一条新规则还没保存',
  '本会话权限更改尚未应用',
]);
const cleared = report(changed, 'model', '');
assert.deepEqual(holdReasons(cleared), ['「审批规则」里有一条新规则还没保存', '本会话权限更改尚未应用']);
assert.deepEqual(Object.hasOwn(cleared, 'model'), false, '收回之后不留一条空的');

// 内容没有变化时，复用原对象，避免触发不必要的重渲染。
assert.equal(report(both, 'model', '「模型与端点」里的「服务地址」还没保存'), both, '重复报同一句不该造出新的表');
assert.equal(report(both, 'keys', ''), both, '没报过的格子收回一句也不该造出新的表');

console.log('桌面前端的离开拦路检查通过');
