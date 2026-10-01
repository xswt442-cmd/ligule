// 五层配置折成一个只读快照（D8）。LAYER_ORDER 由低到高，同一件事在两层各写一次时由靠后的那一层生效。
// 这里只管折：谁去读这些层的文件与命令行标志属于装载侧，内核拿到的是已经折好的快照。
import { KernelError } from './error.js';

// 层名与 D8 定的五层一一对应：用户 < 项目 < 本地 < 命令行标志 < 管理端。
export const LAYER_ORDER = ['user', 'project', 'local', 'flag', 'managed'];

// 只有「一张表」才算可合并的对象：类实例（TOML 的日期时间就是这么一个）没有自己的键，
// 按表递归合下去，上层那一份的值会被悄悄丢掉。
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// 嵌套对象按键逐个合，数组与标量整份替换：一层写的是「局部覆盖」，
// 逐项合并数组会把两层的列表接成一条谁都没写过的列表。
// 装载侧合并同一层里的多条命令行覆盖时用的是同一个函数，两处语义不会走岔。
export function mergeInto(target, source) {
  for (const [key, value] of Object.entries(source)) {
    // 项目层那一份文件可能出自别人写的仓库，`["__proto__"]` 这样一段会把值挂到所有对象的原型上，
    // 后面的每一次判定都读得到它。这不是配置里该有的东西，指名报出去，不默默收下也不悄悄丢掉。
    if (key === '__proto__') throw new KernelError('config_key_unsafe', { detail: key });
    if (isPlainObject(value) && isPlainObject(target[key])) mergeInto(target[key], value);
    else target[key] = structuredClone(value);
  }
}

function deepFreeze(value) {
  if (isPlainObject(value) || Array.isArray(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export function createConfig(layers) {
  if (!isPlainObject(layers)) throw new KernelError('config_layers_must_be_object');
  for (const name of Object.keys(layers)) {
    // 层名写错时那一层的内容会整个没人读，所以在这里当场失败而不是默默少折一层。
    if (!LAYER_ORDER.includes(name)) throw new KernelError('config_layer_unknown');
    if (layers[name] !== undefined && !isPlainObject(layers[name])) throw new KernelError('config_layer_must_be_object');
  }
  const snapshot = {};
  for (const name of LAYER_ORDER) {
    if (layers[name] !== undefined) mergeInto(snapshot, layers[name]);
  }
  return deepFreeze(snapshot);
}
