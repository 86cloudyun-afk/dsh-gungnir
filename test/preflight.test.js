// 开工前预检：三态结论、阻塞项、下一步建议、CLI 退出码。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from '../packages/warroom-core/src/testing.js';
import { JumphostManager } from '../packages/warroom-core/src/jumphosts.js';

test('全新战役：无 route/未备份 → degraded（可开工但有提示），并给出下一步', () => {
  const h = harness();
  const r = h.broker.preflight(h.eng.engagement_id);
  assert.equal(r.verdict, 'degraded');
  assert.equal(r.blockers.length, 0);
  assert.ok(r.warnings.some((w) => w.includes('活跃路由')));
  assert.ok(r.warnings.some((w) => w.includes('备份')));
  assert.ok(r.next.some((n) => n.includes('jump acquire')));
  assert.ok(r.next.some((n) => n.includes('wave --dry-run')));
  assert.ok(r.checks.some((c) => c.dim === 'engagement' && c.name === '授权目标' && c.status === 'ok'));
});

test('取出口 + 备份 + 记录出口验证后：ready', async () => {
  const h = harness();
  const { backupHome } = await import('../packages/warroom-core/src/maintenance.js');
  const jm = new JumphostManager({
    globalDb: h.broker.global, getFactStore: (id) => h.broker._eng(id).store,
    listEngagements: () => h.broker.listEngagements(),
  });
  jm.importHosts([{ id: 'pf-jh', addr_v4: '203.0.113.40' }]);
  const acq = jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });
  h.broker.recordEgressCheck(h.eng.engagement_id, { jumphost_id: 'pf-jh', exit_ip: '203.0.113.40', route_id: acq.route_id });
  backupHome({ home: h.home });

  const r = h.broker.preflight(h.eng.engagement_id);
  assert.equal(r.verdict, 'ready', JSON.stringify(r.warnings));
  assert.equal(r.blockers.length, 0);
  assert.ok(r.checks.every((c) => c.status === 'ok'), JSON.stringify(r.checks.filter((c) => c.status !== 'ok')));
});

test('强制出口验证但未记录 → blocked（明确阻塞项）', async () => {
  const h = harness();
  writeFileSync(join(h.home, 'warroom.json'), JSON.stringify({ requireEgressCheck: true, egressMaxAgeMin: 30 }));
  // 配置在构造时读取：写完配置要用新 Broker（这正是"配置严格"的代价与好处）
  const { Broker } = await import('../packages/warroom-core/src/broker.js');
  const broker = new Broker({ home: h.home, adapter: h.adapter });
  const r = broker.preflight(h.eng.engagement_id);
  assert.equal(r.verdict, 'blocked');
  assert.ok(r.blockers.some((b) => b.includes('出口验证')));
  assert.ok(r.next.some((n) => n.includes('先解决阻塞项')));
});

test('密钥权限不为 600 → blocked', () => {
  const h = harness();
  h.broker.secrets.put('pf-secret', { label: 'x' });
  chmodSync(join(h.home, 'secrets', 'key.bin'), 0o644);
  const r = h.broker.preflight(h.eng.engagement_id);
  assert.equal(r.verdict, 'blocked');
  assert.ok(r.blockers.some((b) => b.includes('密钥权限')), JSON.stringify(r.blockers));
  // 恢复 600 后又可开工（提示项仍在：无 route/无备份）
  chmodSync(join(h.home, 'secrets', 'key.bin'), 0o600);
  assert.notEqual(h.broker.preflight(h.eng.engagement_id).verdict, 'blocked');
});

test('CLI preflight：blocked 时非零退出；degraded 时零退出', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  const run = (args) => {
    try {
      return { code: 0, out: execFileSync('node', ['bin/warroom.mjs', 'preflight', '--engagement', h.eng.engagement_id, '--home', h.home, '--json', ...args], { encoding: 'utf8', env }) };
    } catch (e) { return { code: e.status, out: e.stdout ?? '' }; }
  };
  const degraded = run([]);
  assert.equal(degraded.code, 0, 'degraded 不阻塞');
  assert.equal(JSON.parse(degraded.out).verdict, 'degraded');
});
