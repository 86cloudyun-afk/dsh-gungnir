// 插件骨架验收：服务工厂（三种 adapter）、DSH 工具包装、cordis apply 契约、启动再水化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWarroomService, makeAdapter, apply, SERVICE_NAME } from '../packages/warroom-plugin/src/service.js';
import { dshTools, TOOL_NAMES } from '../packages/warroom-plugin/src/tools.js';
import { TOOLS } from '../packages/warroom-tools/src/index.js';
import { validateToolSet } from '../scripts/validate-tool-schemas.mjs';

test('服务工厂：三种 adapter 均可引导，且启动即再水化', () => {
  for (const kind of ['fake', 'local', 'bridge']) {
    const home = mkdtempSync(join(tmpdir(), `wr-plugin-${kind}-`));
    const svc = createWarroomService({ home, adapterKind: kind });
    assert.ok(svc.broker && svc.jumps, `${kind} 服务未就绪`);
    assert.equal(typeof svc.recovered.hydrated, 'number');
  }
});


test('未知 adapterKind → 抛错（fail-closed，禁止静默退回 FakeAdapter）', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-plugin-badkind-'));
  assert.throws(
    () => createWarroomService({ home, adapterKind: 'bridg' }),
    (e) => e && e.code === 'E_GATE_MISSING_TUPLE' && /unknown adapterKind/.test(e.message),
  );
  assert.throws(
    () => makeAdapter('turbo'),
    (e) => e && e.code === 'E_GATE_MISSING_TUPLE' && /turbo/.test(e.message),
  );
  // 缺省 / undefined 仍是合法的 fake（安全默认，不是静默降级）
  assert.equal(makeAdapter().instanceId, makeAdapter('fake').instanceId);
  assert.equal(makeAdapter(undefined).instanceId, makeAdapter('fake').instanceId);
});

test('apply(ctx) 注册服务并响应 dispose（cordis 契约）', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-plugin-apply-'));
  const registered = {};
  const handlers = {};
  const ctx = {
    provide: (name, val) => { registered[name] = val; },
    on: (evt, fn) => { handlers[evt] = fn; },
  };
  const svc = apply(ctx, { home });
  assert.equal(registered[SERVICE_NAME], svc);
  assert.equal(typeof handlers.dispose, 'function');
  handlers.dispose(); // 不应抛错
});

test('DSH 工具包装：数量与预设一致，schema 全部合法，execute 走 broker', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-plugin-tools-'));
  const svc = createWarroomService({ home });
  const tools = dshTools(svc);
  assert.equal(tools.length, TOOLS.length);
  assert.deepEqual(tools.map((t) => t.name), TOOL_NAMES);

  // 复用 CI 的 schema 校验器（形态：name/description/input_schema/run）——包装层同样必须合规
  const asSpec = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, run: t.execute }));
  const { ok, errors } = validateToolSet(asSpec);
  assert.equal(ok, true, errors.join('\n'));

  // 实际执行一条：engage → execute → 状态可查
  const eng = svc.broker.createEngagement({ user_message_id: 'um-plugin', targets: ['10.0.0.0/24'] });
  const exec = tools.find((t) => t.name === 'warroom_execute');
  const r = exec.execute({
    command_id: 'plugin-1', engagement_id: eng.engagement_id, auth_version: 1,
    contract: { targets: ['10.0.0.5'], action_class: 'active', resources: [], wire_cost: 0 },
  });
  assert.equal(r.state, 'running');
  const status = tools.find((t) => t.name === 'warroom_status');
  assert.equal(status.execute({ engagement_id: eng.engagement_id, task_id: r.task_id }).ledger_state, 'running');
});

test('包装层四元组预检：缺 auth_version 直接拒绝（不进入 broker）', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-plugin-4t-'));
  const svc = createWarroomService({ home });
  const exec = dshTools(svc).find((t) => t.name === 'warroom_execute');
  assert.throws(
    () => exec.execute({ command_id: 'x', engagement_id: 'eng_x', contract: { targets: ['1.1.1.1'], action_class: 'active' } }),
    (e) => e.code === 'E_GATE_MISSING_TUPLE'
  );
});

test('bridge 模式在 home 下创建 spool 目录（协议就位）', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-plugin-bridge-'));
  createWarroomService({ home, adapterKind: 'bridge' });
  assert.ok(existsSync(join(home, 'dsh-bridge', 'outbox')));
  assert.ok(existsSync(join(home, 'dsh-bridge', 'inbox')));
});
