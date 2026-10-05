// op_log 先行补偿 + TTL 隔离（ADR-002 D6 rev2 验收）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../packages/warroom-core/src/testing.js';
import { JumphostManager } from '../packages/warroom-core/src/jumphosts.js';

test('op_log 先行：fact 写失败 → 补偿拆除 + 租约释放；恢复后审计补齐', () => {
  const h = harness();
  const g = h.broker.global;
  const jm = new JumphostManager({ globalDb: g, getFactStore: (id) => h.broker._eng(id).store });
  jm.importHosts([{ id: 'jh-1', addr_v4: '203.0.113.10', quota: 3 }]);
  const store = h.store();

  store.faults.write_fail = true;
  assert.throws(
    () => jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' }),
    (e) => e.code === 'E_COMPENSATED'
  );
  // 补偿：租约释放 + op_log 走完补偿态 + teardown 动作留痕
  assert.equal(g.prepare("SELECT state FROM leases WHERE jumphost_id = 'jh-1'").get().state, 'released');
  assert.equal(g.prepare("SELECT COUNT(*) c FROM op_log WHERE state = 'released'").get().c, 1);
  assert.ok(jm.teardowns.length >= 1);
  // 补偿期间 fact 无审计（写失败）
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM egress_checks').get().c, 0);

  // 恢复后补齐（带 recovered_at）
  store.faults.write_fail = false;
  store.backfillEgressCheck({ jumphost_id: 'jh-1', exit_ip: '203.0.113.10', verdict: 'pass', route_id: 'backfill-1' });
  const row = store.db.prepare('SELECT recovered_at, verdict FROM egress_checks WHERE route_id = ?').get('backfill-1');
  assert.equal(row.verdict, 'pass');
  assert.ok(row.recovered_at);
});

test('正常 acquire：租约激活、出口实测 pass、配额计数', () => {
  const h = harness();
  const jm = new JumphostManager({ globalDb: h.broker.global, getFactStore: (id) => h.broker._eng(id).store });
  jm.importHosts([{ id: 'jh-2', addr_v4: '203.0.113.11', quota: 3 }]);
  const r = jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });
  assert.match(r.socks, /^socks5:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(h.broker.global.prepare('SELECT used_today FROM jumphosts WHERE id = ?').get('jh-2').used_today, 1);
  assert.equal(h.store().db.prepare('SELECT verdict FROM egress_checks').get().verdict, 'pass');
});

test('TTL 到期未证实释放 → quarantined，不再分配（负样本）', () => {
  const h = harness();
  const jm = new JumphostManager({
    globalDb: h.broker.global,
    getFactStore: (id) => h.broker._eng(id).store,
    runtimeProbe: () => true, // 资源仍在运行
    ttlMinutes: 0,            // 立即到期
  });
  jm.importHosts([{ id: 'jh-3', addr_v4: '203.0.113.12', quota: 3 }]);
  jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });

  const swept = jm.sweepExpired();
  assert.equal(swept[0].state, 'quarantined');
  assert.equal(h.broker.global.prepare("SELECT status FROM jumphosts WHERE id = 'jh-3'").get().status, 'quarantined');
  assert.throws(
    () => jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' }),
    (e) => e.code === 'E_NO_JUMPHOST'
  );
});

test('跨天滚动：往日用满的跳板，新的一天配额完整恢复（不被往日 used_today 污染）', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-02T12:00:00.000Z') });
  const h = harness();
  const g = h.broker.global;
  const jm = new JumphostManager({ globalDb: g, getFactStore: (id) => h.broker._eng(id).store });
  jm.importHosts([{ id: 'jh-roll', addr_v4: '203.0.113.60', quota: 3 }]);

  // 昨天把配额用满（day=昨天、used_today=quota）
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  g.prepare("UPDATE jumphosts SET used_today = 3, day = ? WHERE id = 'jh-roll'").run(yesterday);

  // 今天第一次 acquire：当日计数应从 1 起算（而非在往日 3 上 +1）
  jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });
  const after1 = g.prepare("SELECT used_today, day FROM jumphosts WHERE id = 'jh-roll'").get();
  assert.equal(after1.used_today, 1, '新一天首个 acquire 后 used_today 必须为 1');
  assert.equal(after1.day, new Date().toISOString().slice(0, 10));

  // 今日配额为 3：应还能再取满剩余 2 次，不得被往日用量提前耗尽
  jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.6' });
  jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.7' });
  assert.equal(g.prepare("SELECT used_today FROM jumphosts WHERE id = 'jh-roll'").get().used_today, 3);

  // 第 4 次（超今日配额）才应拒绝
  assert.throws(
    () => jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.8' }),
    (e) => e.code === 'E_NO_JUMPHOST'
  );
});
