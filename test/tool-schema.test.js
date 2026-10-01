// 工具 schema 校验器的正负样本（CI 三闸之一的自我测试）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../packages/warroom-tools/src/index.js';
import { validateToolSet } from '../scripts/validate-tool-schemas.mjs';

test('现有工具集全部通过 schema 校验', () => {
  const { ok, errors } = validateToolSet(TOOLS);
  assert.equal(ok, true, errors.join('\n'));
});

test('负样本：object 缺 additionalProperties 被拒（DSH 挂载硬要求）', () => {
  const bad = [{
    name: 'warroom_bad', description: '故意缺失的负样本工具',
    input_schema: { type: 'object', properties: { a: { type: 'string' } } },
    run: () => {},
  }];
  const { ok, errors } = validateToolSet(bad);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('additionalProperties')));
});

test('负样本：required 指向不存在的属性被拒', () => {
  const bad = [{
    name: 'warroom_bad2', description: 'required 悬空的负样本工具',
    input_schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'], additionalProperties: false },
    run: () => {},
  }];
  const { ok, errors } = validateToolSet(bad);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('required "b"')));
});

test('负样本：非受支持关键字 / 非法命名被拒', () => {
  const bad = [{
    name: 'BadName', description: '命名与关键字都不合规的负样本',
    input_schema: { type: 'object', properties: {}, required: ['x'], additionalProperties: false, allOf: [] },
    run: () => {},
  }];
  const { ok, errors } = validateToolSet(bad);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('warroom_[a-z_]+')));
  assert.ok(errors.some((e) => e.includes('allOf')));
});
