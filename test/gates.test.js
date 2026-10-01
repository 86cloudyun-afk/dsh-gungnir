// 门闸负样本 + 撤销级联（ADR-001 验收 2/3 + 框架 §8 验收 2/3）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../packages/shared-types/src/index.js';
import { harness } from '../packages/warroom-core/src/testing.js';

function expectCode(fn, code) {
  try {
    fn();
    assert.fail(`expected error ${code}`);
  } catch (e) {
    assert.equal(e.code, code, `want ${code}, got ${e.code}: ${e.message}`);
  }
}

test('缺四元组被拒绝（无 auth_version）', () => {
  const h = harness();
  const { engagement_id } = h.eng;
  expectCode(
    () => h.broker.execute({ engagement_id, contract: h.contract() }),
    ERR.E_GATE_MISSING_TUPLE
  );
});

test('请求资产超出授权 scope 被拒绝', () => {
  const h = harness();
  expectCode(
    () => h.broker.execute({ ...h.base, command_id: 'g1', contract: h.contract({ targets: ['172.16.0.5'] }) }),
    ERR.E_GATE_OUT_OF_SCOPE
  );
});

test('撤销后旧 auth_version 被拒绝', () => {
  const h = harness();
  h.broker.revoke(h.eng.engagement_id, 'test');
  expectCode(
    () => h.broker.execute({ ...h.base, command_id: 'g2', contract: h.contract() }),
    ERR.E_GATE_AUTH_EXPIRED
  );
});

test('destructive 无人工批准被拒绝；带批准通过', () => {
  const h = harness();
  expectCode(
    () => h.broker.execute({ ...h.base, command_id: 'g3', contract: h.contract({ action_class: 'destructive' }) }),
    ERR.E_GATE_DESTRUCTIVE_NEEDS_APPROVAL
  );
  const ap = h.broker.createApproval({ engagement_id: h.eng.engagement_id, reason: '测试批准' });
  const ok = h.broker.execute({
    ...h.base, command_id: 'g4',
    contract: h.contract({ action_class: 'destructive' }),
    manual_approval_token: ap.approval_id,
  });
  assert.equal(ok.state, 'running');
});

test('action_class 超过授权上限被拒绝', () => {
  const h = harness({ authOverrides: { action_class_limit: 'readonly' } });
  expectCode(
    () => h.broker.execute({ ...h.base, command_id: 'g5', contract: h.contract({ action_class: 'active' }) }),
    ERR.E_GATE_CLASS_EXCEEDS_LIMIT
  );
});

test('时间窗外被拒绝', () => {
  const h = harness({ authOverrides: { window_end: new Date(Date.now() - 1000).toISOString() } });
  expectCode(
    () => h.broker.execute({ ...h.base, command_id: 'g6', contract: h.contract() }),
    ERR.E_GATE_WINDOW_CLOSED
  );
});

test('撤销级联停止全部运行任务；账本终态 confirmed_stopped', () => {
  const h = harness();
  const t1 = h.broker.execute({ ...h.base, command_id: 'r1', contract: h.contract() });
  const t2 = h.broker.execute({ ...h.base, command_id: 'r2', contract: h.contract() });
  const r = h.broker.revoke(h.eng.engagement_id, 'test-revoke');
  assert.equal(r.auth_version, 2);
  for (const c of r.cancelled) {
    assert.equal(c.state, 'confirmed_stopped');
  }
  // 运行时（adapter）与账本（broker）状态分离：adapter 停在 cancel_requested，账本已证实停止
  assert.equal(h.adapter.status(t1.task_id).state, 'cancel_requested');
  expectCode(
    () => h.broker.execute({ ...h.base, command_id: 'r3', contract: h.contract() }),
    ERR.E_GATE_AUTH_EXPIRED
  );
});
