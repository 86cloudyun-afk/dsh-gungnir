// 效率视图：角色/档位分桶 + 返工率（编制与档位决策的数字依据）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../packages/warroom-core/src/testing.js';

test('按角色与档位分桶：任务/令牌/有效产出/耗时分别聚合', () => {
  const h = harness();
  const a = h.broker.execute({ ...h.base, command_id: 'eff-1', contract: h.contract() });
  const b = h.broker.execute({ ...h.base, command_id: 'eff-2', contract: h.contract() });

  h.broker.recordMetrics(h.eng.engagement_id, 'eff-1', {
    tokens_in: 1000, tokens_out: 200, wall_time_ms: 30_000, verified_facts: 3,
    role: 'recon', model_tier: 'flash',
  });
  h.broker.recordMetrics(h.eng.engagement_id, 'eff-2', {
    tokens_in: 4000, tokens_out: 800, wall_time_ms: 120_000, verified_facts: 2,
    role: 'chain', model_tier: 'pro',
  });
  void a; void b;

  const m = h.broker.metrics(h.eng.engagement_id);
  assert.equal(m.by_role.recon.tokens, 1200);
  assert.equal(m.by_role.recon.verified, 3);
  assert.equal(m.by_role.recon.ms_per_verified_fact, 10_000);
  assert.equal(m.by_tier.pro.tokens, 4800);
  assert.equal(m.by_tier.flash.verified, 3);
  // 便宜的档位在这个样本里更划算（每 1000 token 产出更高）
  assert.ok(m.by_tier.flash.facts_per_1000_tokens > m.by_tier.pro.facts_per_1000_tokens);
});

test('返工率：重派过的任务计入，未决状态单列（效率的真实敌人）', () => {
  const h = harness({ faults: { loseResponse: true, containerResidue: true } });
  const r1 = h.broker.execute({ ...h.base, command_id: 'eff-r1', contract: h.contract({ resources: ['container'] }) });
  const r2 = h.broker.execute({ ...h.base, command_id: 'eff-r2', contract: h.contract() });

  // r1 有容器残留 → unresolved；随后清残留并重派（attempt=2 → 计一次返工）
  h.broker.cancel(h.eng.engagement_id, r1.task_id, 'test');
  h.adapter.faults.containerResidue = false;
  const settled = h.broker.reconcile(h.eng.engagement_id, r1.task_id);
  h.broker.redispatch(h.eng.engagement_id, r1.task_id, '清残留后重派');

  const m = h.broker.metrics(h.eng.engagement_id);
  assert.equal(m.commands, 2);
  assert.equal(m.rework.tasks_with_retry, 1);
  assert.equal(m.rework.retry_rate, 0.5);
  assert.ok(m.rework.unknown >= 1, '丢回包的任务应计入 unknown 统计');
  void settled; void r2;
});

test('无数据时不造假指标（null 而非 0 或 NaN）', () => {
  const h = harness();
  const m = h.broker.metrics(h.eng.engagement_id);
  assert.equal(m.tasks, 0);
  assert.equal(m.facts_per_1000_tokens, null);
  assert.equal(m.ms_per_fact, null);
  assert.equal(m.rework.retry_rate, null);
});

test('工具 warroom_metrics 输出同时含 by_role/by_tier/rework', () => {
  const h = harness();
  const t = { broker: h.broker };
  h.broker.execute({ ...h.base, command_id: 'eff-t', contract: h.contract() });
  h.broker.recordMetrics(h.eng.engagement_id, 'eff-t', { tokens_in: 10, role: 'recon', model_tier: 'flash' });
  const m = t.broker.metrics(h.eng.engagement_id);
  assert.ok('by_role' in m && 'by_tier' in m && 'rework' in m);
});
