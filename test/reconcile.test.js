// 对账与尝试代际（ADR-003 D3/D6）：unknown 不默认失败重做；重派升 attempt 换 generation。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../packages/warroom-core/src/testing.js';

test('unknown → reconcile 依探针定论（不产生自动重做）', () => {
  const h = harness({ faults: { loseResponse: true } });
  const r = h.broker.execute({ ...h.base, command_id: 'rc-1', contract: h.contract() });
  assert.equal(r.state, 'unknown');

  // 执行器侧资源已停（会话/容器均不在）→ 探针定论 done
  h.adapter.tasks.get('rc-1').session_up = false;
  const rec = h.broker.reconcile(h.eng.engagement_id, r.task_id);
  assert.equal(rec.state, 'done');
  const st = h.broker.status(h.eng.engagement_id, r.task_id);
  assert.equal(st.ledger_state, 'done');
  assert.equal(st.attempt, 1);
});

test('reconcile 只接受 unknown/unresolved：running 任务拒绝', () => {
  const h = harness();
  const r = h.broker.execute({ ...h.base, command_id: 'rc-2', contract: h.contract() });
  assert.throws(
    () => h.broker.reconcile(h.eng.engagement_id, r.task_id),
    (e) => e.code === 'E_TASK_NOT_RECONCILABLE'
  );
});

test('资源残留时 reconcile 维持 unresolved', () => {
  const h = harness({ faults: { containerResidue: true } });
  const r = h.broker.execute({ ...h.base, command_id: 'rc-3', contract: h.contract({ resources: ['container'] }) });
  const c = h.broker.cancel(h.eng.engagement_id, r.task_id, 'test');
  assert.equal(c.state, 'unresolved');
  const rec = h.broker.reconcile(h.eng.engagement_id, r.task_id);
  assert.equal(rec.state, 'unresolved');
  assert.ok(rec.residual.length >= 1);
});

test('重派：failed/unresolved → attempt+1、generation 换届；旧代回执被隔离', () => {
  const h = harness({ faults: { loseResponse: true } });
  const r1 = h.broker.execute({
    ...h.base, command_id: 'rd-1', contract: h.contract({ resources: ['container'] }),
  });
  // 会话已停、容器仍在 → 资源残留 → unresolved
  h.adapter.tasks.get('rd-1').session_up = false;
  const rec = h.broker.reconcile(h.eng.engagement_id, r1.task_id);
  assert.equal(rec.state, 'unresolved');

  const re = h.broker.redispatch(h.eng.engagement_id, r1.task_id, '清理后重派');
  assert.equal(re.attempt, 2);
  assert.notEqual(re.generation, r1.generation);

  // 旧代回执（generation 仍是第一代）→ 隔离，不入账
  const staleReceipt = { receipt_id: 'rcp-stale', generation: r1.generation, members: h.contract().fake_members };
  const c1 = h.broker.collect(h.eng.engagement_id, r1.task_id, staleReceipt);
  assert.equal(c1.accepted, false);
  assert.equal(c1.quarantined, 'generation');

  // 新代回执 → 正常入账
  const fresh = h.adapter.collect(r1.task_id, { generation: re.generation, members: h.contract().fake_members });
  const c2 = h.broker.collect(h.eng.engagement_id, r1.task_id, fresh);
  assert.equal(c2.accepted, true);
  assert.equal(h.store().effectiveCount(), 1);
});

test('非法状态迁移被拒（迁移表强制）', () => {
  const h = harness();
  const r = h.broker.execute({ ...h.base, command_id: 'tr-1', contract: h.contract() });
  // running → queued 不在迁移表内
  assert.throws(
    () => h.broker._setCommandState(r.command_id ?? 'x', 'queued'),
    (e) => e.code === 'E_TASK_NOT_FOUND' || e.code === 'E_INVALID_TRANSITION'
  );
  const cmd = h.broker._findCommand(r.task_id);
  assert.throws(
    () => h.broker._setCommandState(cmd.command_id, 'queued'),
    (e) => e.code === 'E_INVALID_TRANSITION'
  );
});

test('status 全景：账本态 + 运行态 + 清单探针 + 尝试次数', () => {
  const h = harness();
  const r = h.broker.execute({ ...h.base, command_id: 'st-1', contract: h.contract({ resources: ['container'] }) });
  const st = h.broker.status(h.eng.engagement_id, r.task_id);
  assert.equal(st.ledger_state, 'running');
  assert.equal(st.runtime_state, 'running');
  assert.equal(st.attempt, 1);
  assert.equal(st.manifest.length, 2);
  assert.ok(st.manifest.every((m) => m.confirmed_stopped === false));
});
