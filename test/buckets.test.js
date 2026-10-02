// 执行三桶（框架 §4）：桶 A 需出口、桶 B 禁 socks、桶 C 需跳板；预检按配置校验自洽。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from '../packages/warroom-core/src/testing.js';
import { JumphostManager } from '../packages/warroom-core/src/jumphosts.js';
import { planBucket, checkBucketForTask, BUCKETS } from '../packages/warroom-core/src/buckets.js';

test('桶 A：无出口即拒；有 route 时给出不变量与唯一出口', () => {
  assert.throws(() => planBucket({ bucket: 'A' }), (e) => e.code === 'E_FENCE_NO_ROUTE');
  const plan = planBucket({ bucket: 'A', route: { socks: 'socks5://127.0.0.1:1080', route_id: 'r1', jumphost_id: 'jh1' } });
  assert.equal(plan.plan.kind, 'container-fence');
  assert.equal(plan.upstream, 'socks5://127.0.0.1:1080');
  assert.ok(plan.invariants.some((i) => i.includes('internal')));
  assert.ok(plan.forbidden.includes('容器直连出网'));
});

test('桶 B：本机直连；挂 socks 即拒', () => {
  const plan = planBucket({ bucket: 'B' });
  assert.equal(plan.plan.kind, 'local');
  assert.equal(plan.upstream, null);
  assert.ok(plan.invariants.some((i) => i.includes('不挂 socks')));
  assert.throws(() => planBucket({ bucket: 'B', route: { socks: 'socks5://127.0.0.1:1080' } }), /不允许经 socks/);
});

test('桶 C：需指定跳板；不变量含"情报不落跳板"', () => {
  assert.throws(() => planBucket({ bucket: 'C' }), (e) => e.code === 'E_NO_JUMPHOST');
  const plan = planBucket({ bucket: 'C', route: { jumphost_id: 'jh2', socks: 'socks5://127.0.0.1:1081' } });
  assert.equal(plan.plan.kind, 'jumphost-side');
  assert.ok(plan.invariants.some((i) => i.includes('不落') || i.includes('只回传')));
  assert.ok(plan.forbidden.includes('在跳板上保存凭据'));
});

test('未知桶被拒（不给默认值）', () => {
  assert.throws(() => planBucket({ bucket: 'D' }), /未知执行桶 D/);
  assert.deepEqual([...BUCKETS], ['A', 'B', 'C']);
});

test('任务级自洽检查：桶 A 有出口/桶 C 有跳板才 ok', () => {
  const contract = { wire_cost: 1 };
  assert.equal(checkBucketForTask({ bucket: 'A', contract, route: { socks: 'socks5://x:1', jumphost_id: 'jh' } }).ok, true);
  assert.equal(checkBucketForTask({ bucket: 'A', contract }).ok, false);
  assert.equal(checkBucketForTask({ bucket: 'C', contract, route: { socks: 'socks5://x:1' } }).ok, false);
  assert.equal(checkBucketForTask({ bucket: 'B', contract }).ok, true);
});

test('预检按配置校验当前桶自洽（语义分层：没取出口是提示，配置矛盾才是阻塞）', () => {
  const h = harness();
  const a = h.broker.preflight(h.eng.engagement_id);
  // 默认桶 A、尚未取出口 → 提示项（取出口本来就是开工第一步），不是硬阻塞
  assert.equal(a.verdict, 'degraded');
  assert.ok(a.warnings.some((w) => w.includes('执行桶 A') && w.includes('活跃 route')));
  assert.equal(a.blockers.some((b) => b.includes('执行桶')), false);
});

test('桶配置矛盾 → blocked（桶 B 却配了经 socks 的出口）', async () => {
  const { Broker } = await import('../packages/warroom-core/src/broker.js');
  const h = harness();
  writeFileSync(join(h.home, 'warroom.json'), JSON.stringify({ bucket: 'B' }));
  const broker = new Broker({ home: h.home, adapter: h.adapter });
  assert.equal(broker.config.bucket, 'B');

  // 桶 B 下出现活跃 route：说明出口策略矛盾（桶 B 明令不允许经 socks）
  const jm = new JumphostManager({
    globalDb: broker.global, getFactStore: (id) => broker._eng(id).store,
    listEngagements: () => broker.listEngagements(),
  });
  jm.importHosts([{ id: 'bk-jh', addr_v4: '203.0.113.50' }]);
  jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });

  const r = broker.preflight(h.eng.engagement_id);
  assert.equal(r.verdict, 'blocked');
  assert.ok(r.blockers.some((b) => b.includes('桶 B') && b.includes('不允许经 socks')));
});
