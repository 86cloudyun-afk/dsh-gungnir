// 效率遥测 + 多战役隔离（ADR-002 D10、框架 §3.1）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../packages/warroom-core/src/testing.js';
import { JumphostManager } from '../packages/warroom-core/src/jumphosts.js';

test('效率遥测：任务级记录幂等覆盖，聚合给出端到端视角', () => {
  const h = harness();
  const a = h.broker.execute({ ...h.base, command_id: 'm-1', contract: h.contract() });
  const b = h.broker.execute({ ...h.base, command_id: 'm-2', contract: h.contract() });

  h.broker.recordMetrics(h.eng.engagement_id, 'm-1', { tokens_in: 1000, tokens_out: 200, wall_time_ms: 30_000, verified_facts: 2, role: 'recon' });
  h.broker.recordMetrics(h.eng.engagement_id, 'm-2', { tokens_in: 500, tokens_out: 100, wall_time_ms: 10_000, verified_facts: 1, role: 'chain' });
  // 同 command 再记 → 覆盖不累加
  h.broker.recordMetrics(h.eng.engagement_id, 'm-1', { tokens_in: 1200, tokens_out: 250, wall_time_ms: 32_000, verified_facts: 3, role: 'recon' });

  const m = h.broker.metrics(h.eng.engagement_id);
  assert.equal(m.tasks, 2);
  assert.equal(m.tokens_in, 1700);
  assert.equal(m.tokens_out, 350);
  assert.equal(m.wall_time_ms, 42_000);
  assert.equal(m.verified_facts, 4);
  assert.equal(m.by_role.recon.tasks, 1);
  assert.equal(m.by_role.chain.tokens, 600);
  assert.equal(m.ms_per_fact, null, '尚无有效事实入账 → 不造假指标');
});

test('度量的战役归属被强制：跨战役记录被拒', () => {
  const h = harness();
  const other = h.broker.createEngagement({ user_message_id: 'um-x', targets: ['10.0.0.0/24'] });
  h.broker.execute({ ...h.base, command_id: 'm-3', contract: h.contract() });
  assert.throws(
    () => h.broker.recordMetrics(other.engagement_id, 'm-3', { tokens_in: 1 }),
    (e) => e.code === 'E_APPROVAL_MISMATCH'
  );
});

test('多战役隔离：任务/事实/度量互不串味', () => {
  const h = harness();
  const b = h.broker.createEngagement({ user_message_id: 'um-b', targets: ['10.9.0.0/24'] });
  const exA = h.broker.execute({ ...h.base, command_id: 'iso-a', contract: h.contract() });
  const exB = h.broker.execute({
    engagement_id: b.engagement_id, auth_version: b.auth_version, command_id: 'iso-b',
    contract: h.contract({ targets: ['10.9.0.7'] }),
  });
  h.broker.collect(h.eng.engagement_id, exA.task_id, h.adapter.collect(exA.task_id));
  h.broker.collect(b.engagement_id, exB.task_id, h.adapter.collect(exB.task_id));
  h.broker.recordMetrics(h.eng.engagement_id, 'iso-a', { tokens_in: 10 });

  assert.equal(h.broker._eng(h.eng.engagement_id).store.effectiveCount(), 1);
  assert.equal(h.broker._eng(b.engagement_id).store.effectiveCount(), 1);
  assert.equal(h.broker.metrics(h.eng.engagement_id).tokens_in, 10);
  assert.equal(h.broker.metrics(b.engagement_id).tokens_in, 0, '度量不得跨战役累加');

  // A 的撤销不影响 B
  h.broker.revoke(h.eng.engagement_id, 'iso');
  const st = h.broker.status(b.engagement_id, exB.task_id);
  assert.equal(st.ledger_state, 'running');
  const okB = h.broker.execute({
    engagement_id: b.engagement_id, auth_version: b.auth_version, command_id: 'iso-b2',
    contract: h.contract({ targets: ['10.9.0.7'] }),
  });
  assert.equal(okB.state, 'running');
});

test('共享资源全局唯一：两战役共用跳板池，租约不重复记账', () => {
  const h = harness();
  const b = h.broker.createEngagement({ user_message_id: 'um-c', targets: ['10.9.0.0/24'] });
  const jm = new JumphostManager({ globalDb: h.broker.global, getFactStore: (id) => h.broker._eng(id).store });
  jm.importHosts([{ id: 'shared-jh', addr_v4: '203.0.113.5', quota: 5 }]);

  jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });
  jm.acquire({ engagement_id: b.engagement_id, target: '10.9.0.7' });

  const leases = h.broker.global.prepare("SELECT * FROM leases WHERE state='active'").all();
  assert.equal(leases.length, 2);
  assert.deepEqual([...new Set(leases.map((l) => l.engagement_id))].sort(), [h.eng.engagement_id, b.engagement_id].sort());
  // 用量全局计数一次
  assert.equal(h.broker.global.prepare("SELECT used_today FROM jumphosts WHERE id='shared-jh'").get().used_today, 2);
});
