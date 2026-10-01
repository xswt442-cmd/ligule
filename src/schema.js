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
      for (const bound of ['minimum', 'maximum']) {
        if (leaf[bound] !== undefined && typeof leaf[bound] !== 'number') violations.push(`${name}.${bound} must be a number`);
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
