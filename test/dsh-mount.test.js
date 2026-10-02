// DSH 挂载层验收：工具 schema 必须被**真实宿主校验器**接受；注册形态必须符合宿主契约。
// 依赖宿主实现：通过 DSH_CORE_DIR（默认取常见部署路径）导入 @deepseek-ai/dsh-tools；
// 宿主不可用时如实 SKIP（不假装通过）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CANDIDATES = [
  process.env.DSH_CORE_DIR,
  '/Users/appleshu/hack/runtime/dsh-release-20260930-dsh020rc2-fixed/core',
  '/Users/appleshu/hack/runtime/dsh-deploy-20260818/home',
].filter(Boolean);

const coreDir = CANDIDATES.find((d) => existsSync(join(d, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))) ?? null;
const validatorUrl = coreDir
  ? pathToFileURL(join(coreDir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href
  : null;

const { TOOLS } = await import('../packages/warroom-tools/src/index.js');
const { toToolDefinition, DENIED_IN_SCOPE, resolveWarroomHome } = await import('../packages/warroom-plugin/src/dsh-entry.mjs');

test('挂载层硬门槛：36 个工具的 parameters 全部通过宿主 JSON Schema 校验', async (t) => {
  if (!validatorUrl) return t.skip('未找到 DSH 宿主实现（设置 DSH_CORE_DIR）');
  const { assertSupportedJsonSchema, assertObjectJsonSchema } = await import(validatorUrl);
  assert.equal(typeof assertSupportedJsonSchema, 'function');
  const failures = [];
  for (const tool of TOOLS) {
    try {
      assertObjectJsonSchema(tool.input_schema);
      assertSupportedJsonSchema(tool.input_schema);
    } catch (e) {
      failures.push(`${tool.name}: ${e.message}`);
    }
  }
  assert.deepEqual(failures, [], `宿主拒绝的 schema：\n${failures.join('\n')}`);
  assert.equal(TOOLS.length, 36);
});

test('注册形态符合宿主契约：name/description/parameters/output/execute 齐备', () => {
  const def = toToolDefinition({
    name: 'warroom_x', description: 'd', input_schema: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } },
    execute: () => ({ ok: true }),
  });
  assert.equal(def.name, 'warroom_x');
  assert.equal(def.parameters.type, 'object');
  assert.deepEqual(def.parameters.required, ['a']);
  assert.equal(typeof def.execute, 'function');
  assert.equal(typeof def.output.render, 'function');
  assert.deepEqual(def.output.render({}, { ok: true }), [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }]);
  assert.equal(def.output.schema.type, 'object');
});

test('execute 只回传 lossless JSON（函数/undefined 被清理）', async () => {
  const def = toToolDefinition({ name: 'w', description: 'd', input_schema: { type: 'object', additionalProperties: true }, execute: () => ({ fn: () => {}, u: undefined, n: 1 }) });
  const out = await def.execute({});
  assert.deepEqual(out, { n: 1 });
});

test('作用域拒绝清单覆盖通用执行/写/委派工具', () => {
  for (const must of ['bash', 'write', 'edit', 'subagent', 'workflow']) {
    assert.ok(DENIED_IN_SCOPE.includes(must), `拒绝清单缺少 ${must}`);
  }
});

test('家目录解析优先级：config > WARROOM_HOME > DSH_HOME/warroom', () => {
  const env = { ...process.env };
  try {
    process.env.WARROOM_HOME = '/tmp/wh'; process.env.DSH_HOME = '/tmp/dh';
    assert.equal(resolveWarroomHome({ home: '/explicit' }), '/explicit');
    assert.equal(resolveWarroomHome({}), '/tmp/wh');
    delete process.env.WARROOM_HOME;
    assert.equal(resolveWarroomHome({}), '/tmp/dh/warroom');
  } finally {
    process.env.WARROOM_HOME = env.WARROOM_HOME;
    process.env.DSH_HOME = env.DSH_HOME;
  }
});

test('全量注册：36 个工具注册成功且名字唯一（默认不请求 restrict）', async () => {
  const { default: entry } = await import('../packages/warroom-plugin/src/dsh-entry.mjs');
  const registered = [];
  const ctx = {
    tools: { register: (d) => { registered.push(d); return () => {}; } },
    on: () => {},
  };
  const svc = entry.apply(ctx, { home: '/tmp/wr-mount-test' });
  assert.equal(registered.length, 36);
  assert.equal(new Set(registered.map((d) => d.name)).size, 36, '工具名不得重复');
  assert.equal(svc.registered.length, 36);
  assert.equal(svc.restrictStatus, 'not-requested', '主保证是挂载构成，restrict 默认不请求');
});

test('restrict 的两种真实结局：作用域外用不了 → 记状态不致命；作用域内可用 → applied', async () => {
  const { default: entry } = await import('../packages/warroom-plugin/src/dsh-entry.mjs');
  const mkCtx = (restrict) => ({
    tools: { register: () => () => {}, restrict },
    on: () => {},
  });

  // 宿主拒绝（真机行为：restrict 只在 agent 作用域可用）
  const unscoped = entry.apply(mkCtx(() => { throw new Error('tools.restrict() requires a scoped context (agent.ctx)'); }),
    { home: '/tmp/wr-mount-test-2', restrictInScope: true });
  assert.match(unscoped.restrictStatus, /skipped: tools\.restrict\(\) requires a scoped context/);
  assert.equal(unscoped.registered.length, 36, 'restrict 失败不影响工具注册');

  // 作用域内可用
  let deny = null;
  const scoped = entry.apply(mkCtx((f) => { deny = f.deny; return () => {}; }),
    { home: '/tmp/wr-mount-test-3', restrictInScope: true });
  assert.equal(scoped.restrictStatus, 'applied');
  assert.deepEqual([...deny].sort(), [...DENIED_IN_SCOPE].sort());
});
