// 工具参数模式使用受控子集，由 Kernel 负责校验，不依赖通用校验库。
// 注册时拒绝 Kernel 无法执行的校验构造。外部 JSON Schema 如需使用，必须先转换为该子集。
import { KernelError } from './error.js';

const ROOT_KEYS = ['type', 'properties', 'required', 'description'];
const LEAF_KEYS = ['type', 'description', 'minimum', 'maximum'];
const LEAF_TYPES = ['string', 'integer', 'number', 'boolean'];
const NUMBER_TYPES = ['integer', 'number'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 注册时列出所有不支持构造及其路径，便于一次修正完整模式。
export function assertSupportedSchema(schema: Record<string, unknown>): void {
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
      if (leaf.type !== undefined && (typeof leaf.type !== 'string' || !LEAF_TYPES.includes(leaf.type))) {
        violations.push(`${name}.type "${String(leaf.type)}" is not supported (subset: ${LEAF_TYPES.join('/')})`);
      }
      if (leaf.description !== undefined && typeof leaf.description !== 'string') {
        violations.push(`${name}.description must be a string`);
      }
      // 数值边界只适用于 integer 和 number 字段，且必须是有限数值。
      for (const bound of ['minimum', 'maximum']) {
        if (leaf[bound] === undefined) continue;
        if (typeof leaf[bound] !== 'number' || !Number.isFinite(leaf[bound])) {
          violations.push(`${name}.${bound} must be a finite number`);
        } else if (typeof leaf.type !== 'string' || !NUMBER_TYPES.includes(leaf.type)) {
          violations.push(`${name}.${bound} needs type integer or number`);
        }
      }
      if (typeof leaf.type === 'string' && NUMBER_TYPES.includes(leaf.type)
        && typeof leaf.minimum === 'number' && typeof leaf.maximum === 'number'
        && Number.isFinite(leaf.minimum) && Number.isFinite(leaf.maximum) && leaf.minimum > leaf.maximum) {
        // 下限大于上限时没有合法值，应在注册时报告无效模式。
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

// 调用时使用受控子集校验参数，返回所有违规项；空列表表示合法。
// 未声明字段按 JSON Schema 默认规则允许。
export function validateArgs(schema: Record<string, unknown>, args: unknown): string[] {
  if (!isPlainObject(args)) return ['arguments must be an object'];
  const violations = [];
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key !== 'string') continue;
    if (args[key] === undefined) violations.push(`missing required property "${key}"`);
  }
  for (const [key, value] of Object.entries(args)) {
    const leaf = properties[key];
    if (!isPlainObject(leaf) || value === undefined) continue;
    const type = leaf.type;
    if (type === 'string' && typeof value !== 'string') violations.push(`"${key}" must be a string`);
    else if (type === 'integer' && !Number.isInteger(value)) violations.push(`"${key}" must be an integer`);
    else if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) violations.push(`"${key}" must be a number`);
    else if (type === 'boolean' && typeof value !== 'boolean') violations.push(`"${key}" must be a boolean`);
    if (typeof type === 'string' && NUMBER_TYPES.includes(type) && typeof value === 'number') {
      if (typeof leaf.minimum === 'number' && value < leaf.minimum) violations.push(`"${key}" must be at least ${leaf.minimum}`);
      if (typeof leaf.maximum === 'number' && value > leaf.maximum) violations.push(`"${key}" must be at most ${leaf.maximum}`);
    }
  }
  return violations;
}
