// 跳板台账与收口：status 总览、release 幂等、sweep 隔离语义。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { harness } from '../packages/warroom-core/src/testing.js';
import { JumphostManager } from '../packages/warroom-core/src/jumphosts.js';

function makeJm(h, opts = {}) {
  return new JumphostManager({ globalDb: h.broker.global, getFactStore: (id) => h.broker._eng(id).store, egressProbe: (host) => ({ ok: true, exit_ip: host.addr_v4 }), ...opts });
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

test('出口端点以操作员为准：ssh_host 是 socks URL 时直接采用；否则标注占位', () => {
  const h = harness();
  // synthetic-example：纯 fixture，egressProbe 已注入，无网络请求
  const jm = makeJm(h);
  jm.importHosts([{ id: 'jh-real', ssh_host: 'socks5h://proxy.example.test:1080', addr_v4: '203.0.113.9' }]);
  const r = jm.acquire({ engagement_id: h.eng.engagement_id, target: 't.example' });
  assert.equal(r.socks, 'socks5h://proxy.example.test:1080', '必须采用操作员端点，不得编随机端口');
  assert.equal(r.socks_source, 'operator');
  assert.equal(r.exit_ip, '203.0.113.9', '出口 IP 应来自实测探针');

  // 选择策略：有真实出口端点的优先于"台账里但没有出口"的
  const h3 = harness();
  const jm3 = makeJm(h3);
  jm3.importHosts([{ id: 'A-no-endpoint', addr_v4: '203.0.113.1' }, { id: 'Z-with-endpoint', ssh_host: 'socks5h://proxy.example.test:1080', addr_v4: '203.0.113.9' }]);
  const r3 = jm3.acquire({ engagement_id: h3.eng.engagement_id, target: 't.example' });
  assert.equal(r3.jumphost_id, 'Z-with-endpoint', '必须优先挑有出口端点的机器（不按 id 字母序）');
  assert.equal(r3.socks_source, 'operator');

  // 显式指定出口（操作员按轮换策略挑）
  const h4 = harness();
  const jm4 = makeJm(h4);
  jm4.importHosts([{ id: 'jh-a', ssh_host: 'socks5h://proxy.example.test:1080', addr_v4: '203.0.113.9' },
    { id: 'jh-b', ssh_host: 'socks5h://proxy.example.test:1081', addr_v4: '198.51.100.10' }]);
  const r4 = jm4.acquire({ engagement_id: h4.eng.engagement_id, target: 't.example', jumphost_id: 'jh-b' });
  assert.equal(r4.jumphost_id, 'jh-b');
  assert.equal(r4.socks, 'socks5h://proxy.example.test:1081');
  assert.throws(() => jm4.acquire({ engagement_id: h4.eng.engagement_id, target: 't.example', jumphost_id: 'nope' }),
    /指定的跳板不可用/);

  // 未提供端点：如实标注占位，不假装有出口
  const h2 = harness();
  const jm2 = makeJm(h2);
  jm2.importHosts([{ id: 'jh-plain', addr_v4: '203.0.113.9' }]);
  const r2 = jm2.acquire({ engagement_id: h2.eng.engagement_id, target: 't.example' });
  assert.equal(r2.socks_source, 'placeholder');
  assert.match(r2.note, /占位值/);
});
