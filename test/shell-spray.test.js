// shell 状态三字段 + 喷洒断点/防锁死（ADR-002 D8、宪法反模式 5/6 的库化）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../packages/warroom-core/src/testing.js';

test('shell 三字段分离：历史证明不改变当前有效性', () => {
  const h = harness();
  const r = h.broker.recordShellProof(h.eng.engagement_id, { proof: 'root@10.0.0.5', evidence_ref: 'ev-1' });
  assert.equal(r.highest_proof, 'root@10.0.0.5');
  assert.equal(r.current_validity, 'unknown', '拿过 root 不等于当前仍可控');
  assert.equal(r.last_verified_at, null);
});

test('当前有效性只能由再验证推进，且只接受三值', () => {
  const h = harness();
  h.broker.recordShellProof(h.eng.engagement_id, { proof: 'root' });
  const v1 = h.broker.verifyShell(h.eng.engagement_id, { validity: 'likely', evidence_ref: 'probe-1' });
  assert.equal(v1.current_validity, 'likely');
  assert.ok(v1.last_verified_at);

  const v2 = h.broker.verifyShell(h.eng.engagement_id, { validity: 'confirmed_lost', evidence_ref: 'probe-2' });
  assert.equal(v2.current_validity, 'confirmed_lost');
  assert.equal(v2.highest_proof, 'root', '历史证明保留，不被丢失覆盖');

  assert.throws(
    () => h.broker.verifyShell(h.eng.engagement_id, { validity: 'root' }),
    /validity 必须是/
  );
});

test('喷洒断点：同(凭据×服务×账号)已试过 → 断点可见，不重复记账', () => {
  const h = harness();
  const args = { credential_ref: 'sec_x', service: 'ssh', account: 'root' };
  assert.deepEqual(h.broker.sprayCheck(h.eng.engagement_id, args), { locked: false, tried: false });
  h.broker.sprayRecord(h.eng.engagement_id, { ...args, result: 'fail' });
  assert.deepEqual(h.broker.sprayCheck(h.eng.engagement_id, args), { locked: false, tried: true });
  const summary = h.store().spraySummary();
  assert.equal(summary.find((s) => s.result === 'fail').n, 1);
});

test('防锁死：账号一旦 locked，后续喷洒一律拒绝且不落账', () => {
  const h = harness();
  const args = { credential_ref: 'sec_y', service: 'rdp', account: 'admin' };
  h.broker.sprayRecord(h.eng.engagement_id, { ...args, result: 'locked' });
  assert.equal(h.broker.sprayCheck(h.eng.engagement_id, args).locked, true);
  assert.throws(
    () => h.broker.sprayRecord(h.eng.engagement_id, { ...args, result: 'fail' }),
    (e) => e.code === 'E_GATE_RATE_LIMIT'
  );
  // 不落账：只有那条 locked
  const rows = h.store().db.prepare('SELECT COUNT(*) c FROM spray_log').get().c;
  assert.equal(rows, 1);
});

test('非法 result 被拒（枚举约束）', () => {
  const h = harness();
  assert.throws(
    () => h.broker.sprayRecord(h.eng.engagement_id, { credential_ref: 's', service: 'ssh', account: 'a', result: 'maybe' }),
    /result 必须是/
  );
});
