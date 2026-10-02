// 效率四段观测（§11）：排队/交接/执行/返工，全部由已有时间戳算出；无数据为 null。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';

function ctx() {
  const home = mkdtempSync(join(tmpdir(), 'wr-seg-'));
  let now = Date.now();
  const adapter = new FakeAdapter();
  const broker = new Broker({ home, adapter, nowMs: () => now });
  const eng = broker.createEngagement({ user_message_id: 'um-seg', targets: ['10.0.0.0/24'], overrides: { rhythm: 'open' } });
  const contract = (over = {}) => ({
    targets: ['10.0.0.5'], action_class: 'active', resources: [], wire_cost: 0,
    fake_members: [{ entity_type: 'asset', source_id: 'seg-1', revision_no: 1, content_hash: 'h', payload: {} }], ...over,
  });
  return { home, broker, adapter, eng, contract, store: () => broker._eng(eng.engagement_id).store, tick: (ms) => { now += ms; } };
}

/**
 * 时间戳构造器：分段的正确性取决于"事件之间的时间差"，
 * 因此直接改写 ts 到已知时刻（不依赖哪个时钟写的时间戳）——确定性验证计算逻辑。
 */
function stamp(c, taskId, { queueMs = 0, handoffMs = null, execMs = null }) {
  const store = c.store();            // 战役库：engagements / gate_log
  const global = c.broker.global;     // 全局库：command_queue
  const T0 = Date.parse('2026-10-01T00:00:00.000Z');
  store.db.prepare('UPDATE engagements SET created_at = ? WHERE id = ?')
    .run(new Date(T0).toISOString(), c.eng.engagement_id);
  global.prepare('UPDATE command_queue SET ts = ? WHERE task_id = ?')
    .run(new Date(T0 + queueMs).toISOString(), taskId);
  const taskDetail = (decision) => {
    const rows = store.db.prepare('SELECT id, detail FROM gate_log WHERE decision = ?').all(decision);
    const hit = rows.find((r) => (r.detail ?? '').includes(taskId));
    return hit?.id ?? null;
  };
  if (handoffMs !== null) {
    const id = taskDetail('collect');
    if (id !== null) {
      store.db.prepare('UPDATE gate_log SET ts = ? WHERE id = ?')
        .run(new Date(T0 + queueMs + handoffMs).toISOString(), id);
    }
  }
  if (handoffMs !== null && execMs !== null) {
    const id = taskDetail('settle');
    if (id !== null) {
      store.db.prepare('UPDATE gate_log SET ts = ? WHERE id = ?')
        .run(new Date(T0 + queueMs + handoffMs + execMs).toISOString(), id);
    }
  }
}

test('四段分解：排队（立项→首派）、交接（派发→首回执）、执行（首回执→结项）', () => {
  const c = ctx();
  const ex = c.broker.execute({ engagement_id: c.eng.engagement_id, auth_version: 1, action_class: 'active', command_id: 'sg-1', contract: c.contract() });
  c.broker.collect(c.eng.engagement_id, ex.task_id, c.adapter.collect(ex.task_id));
  c.broker.settle(c.eng.engagement_id, ex.task_id);
  stamp(c, ex.task_id, { queueMs: 5000, handoffMs: 3000, execMs: 7000 });

  const m = c.broker.metrics(c.eng.engagement_id);
  assert.equal(m.segments.queue_ms, 5000);
  assert.equal(m.segments.handoff_ms, 3000);
  assert.equal(m.segments.exec_ms, 7000);
  assert.deepEqual(m.segments.samples, { handoff: 1, exec: 1 });
  assert.match(m.segments.basis, /command_queue\.ts/);
});

test('多任务：分段取平均；未结项的任务不计入执行段', () => {
  const c = ctx();
  const a = c.broker.execute({ engagement_id: c.eng.engagement_id, auth_version: 1, action_class: 'active', command_id: 'sg-a', contract: c.contract() });
  c.broker.collect(c.eng.engagement_id, a.task_id, c.adapter.collect(a.task_id));
  c.broker.settle(c.eng.engagement_id, a.task_id);
  const b = c.broker.execute({ engagement_id: c.eng.engagement_id, auth_version: 1, action_class: 'active', command_id: 'sg-b', contract: c.contract() });
  c.broker.collect(c.eng.engagement_id, b.task_id, c.adapter.collect(b.task_id));   // 未结项

  stamp(c, a.task_id, { queueMs: 1000, handoffMs: 2000, execMs: 4000 });
  stamp(c, b.task_id, { queueMs: 4000, handoffMs: 6000 });

  const m = c.broker.metrics(c.eng.engagement_id);
  assert.equal(m.segments.samples.handoff, 2, '两次回执都计入交接样本');
  assert.equal(m.segments.samples.exec, 1, '只有结项的那个有执行段');
  assert.equal(m.segments.handoff_ms, 4000, '(2000+6000)/2');
  assert.equal(m.segments.exec_ms, 4000);
  assert.equal(m.segments.queue_ms, 1000, '排队取最早一次派发');
});

test('返工段：重派过的任务单列（次数 + 墙钟）', () => {
  const c = ctx();
  // 按 ADR-003：unknown → reconcile → unresolved 后才可重派（不能跳过定论直接重派）
  const ex = c.broker.execute({
    engagement_id: c.eng.engagement_id, auth_version: 1, action_class: 'active', command_id: 'sg-r',
    contract: c.contract({ resources: ['container'] }),
  });
  c.adapter.faults.containerResidue = true;
  const cancelled = c.broker.cancel(c.eng.engagement_id, ex.task_id, 'test');
  assert.equal(cancelled.state, 'unresolved');
  c.adapter.faults.containerResidue = false;
  c.broker.redispatch(c.eng.engagement_id, ex.task_id, '清残留后重派');

  c.broker.collect(c.eng.engagement_id, ex.task_id, c.adapter.collect(ex.task_id));
  c.broker.settle(c.eng.engagement_id, ex.task_id);
  stamp(c, ex.task_id, { queueMs: 1000, handoffMs: 2000, execMs: 5000 });

  const m = c.broker.metrics(c.eng.engagement_id);
  assert.equal(m.segments.rework.tasks, 1, '重派过的任务应计入返工');
  // 口径：返工墙钟 = 重派那次任务的"派发 → 结项"，即 交接 2000 + 执行 5000 = 7000
  // （排队 1000 属"立项→首派"，不计入返工本身）
  assert.equal(m.segments.rework.wall_ms, 7000, '返工墙钟 = 派发→结项（交接+执行）');
  assert.ok(m.rework.tasks_with_retry >= 1);
});

test('无数据不编造：空战役的四段全为 null', () => {
  const c = ctx();
  const m = c.broker.metrics(c.eng.engagement_id);
  assert.equal(m.segments.queue_ms, null);
  assert.equal(m.segments.handoff_ms, null);
  assert.equal(m.segments.exec_ms, null);
  assert.equal(m.segments.rework.tasks, 0);
  assert.equal(m.segments.rework.wall_ms, null);
});
