#!/usr/bin/env node
// 工具 schema 严格校验：DSH 挂载预设时会校验每个工具的 schema，
// 一旦不合法（如 type:'object' 缺 additionalProperties）整个预设 mount 失败。
// 本校验器是 CI 三闸之一（框架 §10），只允许受支持的 JSON Schema 子集。
import { TOOLS } from '../packages/warroom-tools/src/index.js';

const ALLOWED_TYPES = ['object', 'string', 'number', 'integer', 'boolean', 'array'];
const ALLOWED_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'oneOf', 'description', 'default',
]);

function validateSchema(schema, path, errors) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    errors.push(`${path}: schema 必须是对象`);
    return;
  }
  for (const k of Object.keys(schema)) {
    if (!ALLOWED_KEYS.has(k)) errors.push(`${path}: 不支持的 schema 关键字 "${k}"（只允许受支持子集）`);
  }
  const { type } = schema;
  const types = Array.isArray(type) ? type : [type];
  if (!type) {
    errors.push(`${path}: 缺少 type`);
  } else if (types.some((t) => !ALLOWED_TYPES.includes(t))) {
    errors.push(`${path}: 非法 type ${JSON.stringify(type)}`);
  }
  if (type === 'object' || types.includes('object')) {
    if (typeof schema.additionalProperties !== 'boolean') {
      errors.push(`${path}: object 必须显式声明 additionalProperties（DSH 挂载硬要求）`);
    }
    if (schema.properties !== undefined) {
      if (typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
        errors.push(`${path}: properties 必须是对象`);
      } else {
        for (const [key, sub] of Object.entries(schema.properties)) {
          validateSchema(sub, `${path}.properties.${key}`, errors);
        }
      }
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.length === 0) {
        errors.push(`${path}: required 必须是非空数组`);
      } else {
        const props = schema.properties ?? {};
        for (const r of schema.required) {
          if (!(r in props)) errors.push(`${path}: required "${r}" 不在 properties 中`);
        }
      }
    }
    if (schema.additionalProperties === false && schema.required === undefined) {
      errors.push(`${path}: additionalProperties:false 时必须声明 required`);
    }
  }
  if (types.includes('array')) {
    if (!schema.items) errors.push(`${path}: array 必须声明 items`);
    else validateSchema(schema.items, `${path}.items`, errors);
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) errors.push(`${path}: enum 必须是非空数组`);
  }
  if (schema.oneOf !== undefined) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) errors.push(`${path}: oneOf 必须是非空数组`);
    else schema.oneOf.forEach((s, i) => validateSchema(s, `${path}.oneOf[${i}]`, errors));
  }
}

/** 校验工具集；返回 { ok, errors }。 */
export function validateToolSet(tools) {
  const errors = [];
  if (!Array.isArray(tools) || tools.length === 0) return { ok: false, errors: ['工具集为空'] };
  const names = new Set();
  for (const t of tools) {
    if (!t || typeof t !== 'object') { errors.push('工具必须是对象'); continue; }
    const label = t.name ?? '(未命名工具)';
    if (typeof t.name !== 'string' || !/^warroom_[a-z_]+$/.test(t.name)) {
      errors.push(`${label}: name 必须匹配 warroom_[a-z_]+`);
    } else if (names.has(t.name)) {
      errors.push(`${label}: 工具名重复`);
    } else {
      names.add(t.name);
    }
    if (typeof t.description !== 'string' || t.description.trim().length < 8) {
      errors.push(`${label}: description 必须是有意义的说明（≥8 字符）`);
    }
    if (typeof t.run !== 'function') errors.push(`${label}: run 必须是函数`);
    validateSchema(t.input_schema, `${label}.input_schema`, errors);
  }
  return { ok: errors.length === 0, errors };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain || process.argv.includes('--run')) {
  const { ok, errors } = validateToolSet(TOOLS);
  if (ok) {
    console.log(`[✓] 工具 schema 校验通过：${TOOLS.length} 个工具`);
  } else {
    console.error(`[✗] 工具 schema 校验失败（${errors.length} 项）：`);
    for (const e of errors) console.error(`    - ${e}`);
    process.exitCode = 1;
  }
}
