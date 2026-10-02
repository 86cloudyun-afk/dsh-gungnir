// 围栏 ↔ 跳板联动：出口必须来自真实 route；无活跃 route 即 fail-closed。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { harness } from '../packages/warroom-core/src/testing.js';
import { JumphostManager } from '../packages/warroom-core/src/jumphosts.js';
import { planFenceForEngagement, verifyFencePlan } from '../packages/warroom-core/src/fence.js';

test('无活跃 route → 拒绝出计划（E_FENCE_NO_ROUTE）', () => {
  const h = harness();
  assert.throws(
    () => planFenceForEngagement({ store: h.store(), engagementId: h.eng.engagement_id }),
    (e) => e.code === 'E_FENCE_NO_ROUTE'
  );
});

test('有活跃 route → 计划上游等于该 route 的 socks，且静态不变量全过', () => {
  const h = harness();
  const jm = new JumphostManager({ globalDb: h.broker.global, getFactStore: (id) => h.broker._eng(id).store });
  jm.importHosts([{ id: 'fence-jh', addr_v4: '203.0.113.7' }]);
  const acq = jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });

  const plan = planFenceForEngagement({ store: h.store(), engagementId: h.eng.engagement_id });
  assert.equal(plan.sidecar.upstream, acq.socks);
  assert.equal(plan.upstream_source.route_id, acq.route_id);
  assert.equal(plan.upstream_source.jumphost_id, 'fence-jh');
  const v = verifyFencePlan(plan);
  assert.equal(v.ok, true, v.errors.join('；'));
});

test('指定不存在的 route → 拒绝（不静默取别的出口）', () => {
  const h = harness();
  const jm = new JumphostManager({ globalDb: h.broker.global, getFactStore: (id) => h.broker._eng(id).store });
  jm.importHosts([{ id: 'fence-jh2', addr_v4: '203.0.113.8' }]);
  jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });
  assert.throws(
    () => planFenceForEngagement({ store: h.store(), engagementId: h.eng.engagement_id, routeId: 'route_nope' }),
    (e) => e.code === 'E_FENCE_NO_ROUTE'
  );
});

test('收口后（route 转 released）不再被视为活跃出口', () => {
  const h = harness();
  const jm = new JumphostManager({ globalDb: h.broker.global, getFactStore: (id) => h.broker._eng(id).store });
  jm.importHosts([{ id: 'fence-jh3', addr_v4: '203.0.113.9' }]);
  const acq = jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });
  jm.releaseRoute({ route_id: acq.route_id, engagementId: h.eng.engagement_id });
  assert.throws(
    () => planFenceForEngagement({ store: h.store(), engagementId: h.eng.engagement_id }),
    (e) => e.code === 'E_FENCE_NO_ROUTE'
  );
});

test('CLI --from-home：有 route 时计划带来源；无 route 时非零退出', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  // 无 route：应失败
  let code = 0;
  try {
    execFileSync('node', ['scripts/fence-verify.mjs', '--engagement', h.eng.engagement_id, '--from-home', h.home, '--json'],
      { encoding: 'utf8', env, stdio: 'pipe' });
  } catch (e) { code = e.status; }
  assert.equal(code, 2, '无 route 时脚本应非零退出（缺 route 提示）');

  // 建 route 后：计划应带 upstream_source
  const jm = new JumphostManager({ globalDb: h.broker.global, getFactStore: (id) => h.broker._eng(id).store });
  jm.importHosts([{ id: 'fence-jh4', addr_v4: '203.0.113.11' }]);
  const acq = jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });
  const out = execFileSync('node', ['scripts/fence-verify.mjs', '--engagement', h.eng.engagement_id, '--from-home', h.home, '--json'],
    { encoding: 'utf8', env });
  const parsed = JSON.parse(out);
  assert.equal(parsed.plan.sidecar.upstream, acq.socks);
});
