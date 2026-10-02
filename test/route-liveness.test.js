// 活跃 route 生命周期：心跳续期、TTL 巡检转 stale、收口后不再活跃。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { harness } from '../packages/warroom-core/src/testing.js';
import { JumphostManager } from '../packages/warroom-core/src/jumphosts.js';
import { planFenceForEngagement } from '../packages/warroom-core/src/fence.js';

const mk = (h, opts = {}) => new JumphostManager({
  globalDb: h.broker.global,
  getFactStore: (id) => h.broker._eng(id).store,
  listEngagements: () => h.broker.listEngagements(),   // 与宿主注入一致
  ...opts,
});

test('心跳：续期租约并刷新路由时间，巡检不判 stale', () => {
  const h = harness();
  const jm = mk(h, { ttlMinutes: 60 });
  jm.importHosts([{ id: 'jh-hb', addr_v4: '203.0.113.20' }]);
  const r = jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });

  const hb = jm.heartbeatRoute({ route_id: r.route_id, engagementId: h.eng.engagement_id });
  assert.equal(hb.route_id, r.route_id);
  const sweep = jm.sweepRoutes();
  assert.equal(sweep.stale.length, 0, '刚续期不应判 stale');
  assert.equal(sweep.scanned, 1);

  // 留痕
  const logs = h.store().db.prepare("SELECT COUNT(*) c FROM gate_log WHERE decision = 'route_heartbeat'").get().c;
  assert.equal(logs, 1);
});

test('租约释放后：路由被巡检判 stale，围栏不再取该出口', () => {
  const h = harness();
  const jm = mk(h);
  jm.importHosts([{ id: 'jh-rel', addr_v4: '203.0.113.21' }]);
  const r = jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });
  jm.release(r.lease_id);

  const sweep = jm.sweepRoutes();
  assert.equal(sweep.stale.length, 1);
  assert.match(sweep.stale[0].reason, /租约已释放/);
  assert.equal(h.store().db.prepare('SELECT state FROM jump_routes WHERE route_id = ?').get(r.route_id).state, 'stale');
  assert.throws(() => planFenceForEngagement({ store: h.store(), engagementId: h.eng.engagement_id }),
    (e) => e.code === 'E_FENCE_NO_ROUTE');
});

test('长时无心跳（>3×TTL）→ stale；心跳后的不误判', () => {
  const h = harness();
  const jm = mk(h, { ttlMinutes: 1 });         // TTL 1 分钟 → stale 阈值 3 分钟
  jm.importHosts([{ id: 'jh-idle', addr_v4: '203.0.113.22' }]);
  const old = jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });
  const fresh = jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.6' });

  // 把老路由的时间改到 5 小时前（模拟长时无心跳）
  h.store().db.prepare('UPDATE jump_routes SET ts = ? WHERE route_id = ?')
    .run(new Date(Date.now() - 5 * 3600_000).toISOString(), old.route_id);

  const sweep = jm.sweepRoutes();
  const staleIds = sweep.stale.map((s) => s.route_id);
  assert.ok(staleIds.includes(old.route_id), '老路由应判 stale');
  assert.ok(!staleIds.includes(fresh.route_id), '新路由不应误判');
});

test('非活跃 route 不能续期；收口后不参与巡检', () => {
  const h = harness();
  const jm = mk(h);
  jm.importHosts([{ id: 'jh-x', addr_v4: '203.0.113.23' }]);
  const r = jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });
  jm.releaseRoute({ route_id: r.route_id, engagementId: h.eng.engagement_id });
  assert.throws(() => jm.heartbeatRoute({ route_id: r.route_id, engagementId: h.eng.engagement_id }), /状态为 released/);
  const sweep = jm.sweepRoutes();
  assert.equal(sweep.scanned, 0, '已收口路由不参与巡检');
});

test('CLI jump sweep-routes / heartbeat 可用', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  const cli = (args) => JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'jump', ...args, '--home', h.home, '--json'], { encoding: 'utf8', env }));
  const jm = mk(h);
  jm.importHosts([{ id: 'jh-cli', addr_v4: '203.0.113.24' }]);
  const r = jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });

  const hb = cli(['heartbeat', '--engagement', h.eng.engagement_id, '--route', r.route_id]);
  assert.equal(hb.route_id, r.route_id);
  const sweep = cli(['sweep-routes']);
  assert.equal(sweep.stale.length, 0);
});
