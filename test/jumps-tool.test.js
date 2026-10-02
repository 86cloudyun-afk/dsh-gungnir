// 跳板台账与收口：status 总览、release 幂等、sweep 隔离语义。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { harness } from '../packages/warroom-core/src/testing.js';
import { JumphostManager } from '../packages/warroom-core/src/jumphosts.js';

function makeJm(h, opts = {}) {
  return new JumphostManager({ globalDb: h.broker.global, getFactStore: (id) => h.broker._eng(id).store, ...opts });
}

test('台账总览：主机/租约/路由计数正确', () => {
  const h = harness();
  const jm = makeJm(h);
  jm.importHosts([{ id: 'j1', addr_v4: '203.0.113.1' }, { id: 'j2', addr_v4: '203.0.113.2' }]);
  const r = jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });

  const s = jm.status(h.eng.engagement_id);
  assert.equal(s.summary.hosts, 2);
  assert.equal(s.summary.healthy, 2);
  assert.equal(s.summary.active_leases, 1);
  assert.equal(s.summary.active_routes, 1);
  assert.equal(s.routes[0].route_id, r.route_id);
});

test('收口：release 幂等，路由转 released、租约释放', () => {
  const h = harness();
  const jm = makeJm(h);
  jm.importHosts([{ id: 'j3', addr_v4: '203.0.113.3' }]);
  const r = jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });

  const out1 = jm.releaseRoute({ route_id: r.route_id, engagementId: h.eng.engagement_id });
  assert.equal(out1.state, 'released');
  const out2 = jm.releaseRoute({ route_id: r.route_id, engagementId: h.eng.engagement_id });
  assert.equal(out2.state, 'released', '重复 release 应幂等');

  const s = jm.status(h.eng.engagement_id);
  assert.equal(s.summary.active_routes, 0);
  assert.equal(s.summary.active_leases, 0);
});

test('CLI jump status / release 可用', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  const jm = makeJm(h);
  jm.importHosts([{ id: 'j4', addr_v4: '203.0.113.4' }]);
  const r = jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });

  const st = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'jump', 'status', '--engagement', h.eng.engagement_id,
    '--home', h.home, '--json'], { encoding: 'utf8', env }));
  assert.equal(st.summary.hosts, 1);
  assert.equal(st.summary.active_routes, 1);

  const rel = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'jump', 'release', '--engagement', h.eng.engagement_id,
    '--route', r.route_id, '--home', h.home, '--json'], { encoding: 'utf8', env }));
  assert.equal(rel.state, 'released');
});

test('工具 warroom_jumps：status/release/sweep 三动作', () => {
  const h = harness();
  const jm = makeJm(h, { runtimeProbe: () => true, ttlMinutes: 0 });
  jm.importHosts([{ id: 'j5', addr_v4: '203.0.113.5' }]);
  const r = jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });

  const status = jm.status(h.eng.engagement_id);
  assert.ok(status.summary.hosts === 1);
  const swept = jm.sweepExpired();
  assert.equal(swept[0].state, 'quarantined');
  const rel = jm.releaseRoute({ route_id: r.route_id, engagementId: h.eng.engagement_id });
  assert.equal(rel.state, 'released');
});
