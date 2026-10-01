// 派发幂等（丢回包恢复）+ 资源清单逐项证实（ADR-003 rev2 验收 1/2）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../packages/warroom-core/src/testing.js';

test('丢回包恢复：断回包 → lookup 找回同一任务，重复派发不产生第二个任务', () => {
  const h = harness({ faults: { loseResponse: true } });
  const r1 = h.broker.execute({ ...h.base, command_id: 'cmd-1', contract: h.contract() });
  assert.equal(r1.state, 'unknown');
  assert.equal(r1.recoverable, true);

  const found = h.adapter.lookup('cmd-1');
  assert.ok(found, 'adapter must have the task');
  assert.equal(found.task_id, r1.task_id);

  // 控制端重启等价：同 command_id 再派发 → 去重返回同一任务
  const r2 = h.broker.execute({ ...h.base, command_id: 'cmd-1', contract: h.contract() });
  assert.equal(r2.deduped, true);
  assert.equal(r2.task_id, r1.task_id);
  assert.equal([...h.adapter.tasks.values()].length, 1);
});

test('正常派发：同 command_id 重复调用返回同一任务（deduped）', () => {
  const h = harness();
  const r1 = h.broker.execute({ ...h.base, command_id: 'cmd-d1', contract: h.contract() });
  const r2 = h.broker.execute({ ...h.base, command_id: 'cmd-d1', contract: h.contract() });
  assert.equal(r1.task_id, r2.task_id);
  assert.equal(r2.deduped, true);
  assert.equal([...h.adapter.tasks.values()].length, 1);
});

test('资源残留负样本：主会话停、容器仍在 → unresolved，不得 confirmed_stopped', () => {
  const h = harness({ faults: { containerResidue: true } });
  const r = h.broker.execute({
    ...h.base, command_id: 'cmd-r',
    contract: h.contract({ resources: ['container'] }),
  });
  const c1 = h.broker.cancel(h.eng.engagement_id, r.task_id, 'test');
  assert.equal(c1.state, 'unresolved');
  assert.ok(c1.manifest.some((m) => m.confirmed === false), 'manifest must show unconfirmed item');

  // 残留清除后再次取消 → 逐项证实 → confirmed_stopped
  h.adapter.faults.containerResidue = false;
  const c2 = h.broker.cancel(h.eng.engagement_id, r.task_id, 'test');
  assert.equal(c2.state, 'confirmed_stopped');
});

test('正常取消：清单逐项证实 → confirmed_stopped', () => {
  const h = harness();
  const r = h.broker.execute({
    ...h.base, command_id: 'cmd-ok',
    contract: h.contract({ resources: ['container'] }),
  });
  const c = h.broker.cancel(h.eng.engagement_id, r.task_id, 'done');
  assert.equal(c.state, 'confirmed_stopped');
  assert.equal(c.manifest.length, 2); // session + container
});

test('取消时每个资源条目只探针一次（避免重复探针与 TOCTOU，ADR-003 D4）', () => {
  const h = harness({ faults: { containerResidue: true } });
  const r = h.broker.execute({
    ...h.base, command_id: 'cmd-probe-once',
    contract: h.contract({ resources: ['container'] }),
  });
  const orig = h.adapter.manifestOf.bind(h.adapter);
  const counts = {};
  h.adapter.manifestOf = (id) =>
    orig(id).map((item) => ({
      ...item,
      check: () => { counts[item.id] = (counts[item.id] ?? 0) + 1; return item.check(); },
    }));
  const c = h.broker.cancel(h.eng.engagement_id, r.task_id, 'test');
  assert.equal(c.state, 'unresolved');
  // 清单两项（session + container）各恰好探针一次
  assert.deepEqual(Object.values(counts).sort(), [1, 1]);
  // 返回清单与探针结果一致：session 已证实、container 未证实
  assert.ok(c.manifest.some((m) => m.kind === 'container' && m.confirmed === false));
  assert.ok(c.manifest.some((m) => m.kind === 'session' && m.confirmed === true));
});

test('缺少 command_id 被拒绝（派发幂等键，ADR-003 D1）', () => {
  const h = harness();
  assert.throws(
    () => h.broker.execute({ ...h.base, contract: h.contract() }),
    (e) => e.code === 'E_GATE_MISSING_TUPLE'
  );
  // 不留下任何命令行与 adapter 任务
  assert.equal(h.broker.global.prepare('SELECT COUNT(*) c FROM command_queue').get().c, 0);
  assert.equal([...h.adapter.tasks.values()].length, 0);
});

test('空串 command_id 被拒绝（避免不同命令误判去重为同一任务）', () => {
  const h = harness();
  assert.throws(
    () => h.broker.execute({ ...h.base, command_id: '', contract: h.contract() }),
    (e) => e.code === 'E_GATE_MISSING_TUPLE'
  );
});
