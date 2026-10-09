// 调用参数的受控子集（D14）：内置工具的参数模式只用这些构造，内核自己校验，不引通用校验库。
// 子集之外的构造在注册期就拒：模式已经作为清单交给模型，内核不校验的构造等于承诺了一件做不到的事。
// 外部带来的完整 JSON Schema 要先经一层独立适配降到这个子集，那一层当前没有使用者。
import { KernelError } from './error.js';

const ROOT_KEYS = ['type', 'properties', 'required', 'description'];
const LEAF_KEYS = ['type', 'description', 'minimum', 'maximum'];
const LEAF_TYPES = ['string', 'integer', 'number', 'boolean'];
const NUMBER_TYPES = ['integer', 'number'];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 注册期用：把子集之外的构造连它的路径一次报全，插件作者不必一轮改一处。
export function assertSupportedSchema(schema) {
  const violations = [];
  for (const key of Object.keys(schema)) {
    if (!ROOT_KEYS.includes(key)) violations.push(`${key} is not supported at the root (subset: ${ROOT_KEYS.join('/')})`);
  }
  if (schema.description !== undefined && typeof schema.description !== 'string') {
    violations.push('description must be a string');
  }
  const properties = schema.properties ?? {};
  if (!isPlainObject(properties)) {
    violations.push('properties must be an object of schemas');
  } else {
    for (const [name, leaf] of Object.entries(properties)) {
      if (!isPlainObject(leaf)) {
        violations.push(`${name} must be a schema object`);
        continue;
      }
      for (const key of Object.keys(leaf)) {
        if (!LEAF_KEYS.includes(key)) violations.push(`${name}.${key} is not supported (subset: ${LEAF_KEYS.join('/')})`);
      }
      if (leaf.type !== undefined && !LEAF_TYPES.includes(leaf.type)) {
        violations.push(`${name}.type "${leaf.type}" is not supported (subset: ${LEAF_TYPES.join('/')})`);
      }
      if (leaf.description !== undefined && typeof leaf.description !== 'string') {
        violations.push(`${name}.description must be a string`);
      }
      // 上下界只在数值类型上校验得了。D14 定的判据是「内核不校验的构造等于承诺一件做不到的事」，
      // 所以字符串上的 minimum 要在注册期就指名拒掉：收下之后它一点作用也没有，用的人看不出来；
      // 非有限的界值同样生效不了（任何数与 NaN 比都小于 false）。
      for (const bound of ['minimum', 'maximum']) {
        if (leaf[bound] === undefined) continue;
        if (typeof leaf[bound] !== 'number' || !Number.isFinite(leaf[bound])) {
          violations.push(`${name}.${bound} must be a finite number`);
        } else if (!NUMBER_TYPES.includes(leaf.type)) {
          violations.push(`${name}.${bound} needs type integer or number`);
        }
      }
      if (NUMBER_TYPES.includes(leaf.type) && leaf.minimum !== undefined && leaf.maximum !== undefined
        && Number.isFinite(leaf.minimum) && Number.isFinite(leaf.maximum) && leaf.minimum > leaf.maximum) {
        // 反过来的一对界值会让这个参数无解：那是写错了模式，当场说清楚比每次调用都拒更好。
        violations.push(`${name} has minimum above maximum`);
      }
    }
  }
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some((key) => typeof key !== 'string')) {
    violations.push('required must be an array of strings');
  } else {
    for (const key of required) {
      if (!Object.hasOwn(properties, key)) violations.push(`required names "${key}" which is not in properties`);
    }
  }
  if (violations.length > 0) {
    throw new KernelError('tool_parameters_unsupported_construct', { detail: violations.join('; ') });
  }
}

// 调用期用：按上面那个子集校验参数，返回违规列表，空列表就是合法。
// 模式里没有声明的键按 JSON Schema 的默认放过，多一个键不算失败。
export function validateArgs(schema, args) {
  if (!isPlainObject(args)) return ['arguments must be an object'];
  const violations = [];
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) violations.push(`missing required property "${key}"`);
  }
  for (const [key, value] of Object.entries(args)) {
    const leaf = properties[key];
    if (leaf === undefined || value === undefined) continue;
    const { type } = leaf;
    if (type === 'string' && typeof value !== 'string') violations.push(`"${key}" must be a string`);
    else if (type === 'integer' && !Number.isInteger(value)) violations.push(`"${key}" must be an integer`);
    else if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) violations.push(`"${key}" must be a number`);
    else if (type === 'boolean' && typeof value !== 'boolean') violations.push(`"${key}" must be a boolean`);
    if (NUMBER_TYPES.includes(type) && typeof value === 'number') {
      if (leaf.minimum !== undefined && value < leaf.minimum) violations.push(`"${key}" must be at least ${leaf.minimum}`);
      if (leaf.maximum !== undefined && value > leaf.maximum) violations.push(`"${key}" must be at most ${leaf.maximum}`);
    }
  }
  return violations;
}
