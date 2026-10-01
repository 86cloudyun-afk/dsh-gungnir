// 节奏闸（并发/wire 预算/最小间隔）+ 人工批准令牌（destructive 裁决）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../packages/warroom-core/src/testing.js';

test('并发闸：达到节奏档上限后拒绝新任务（restricted=2）', () => {
  const h = harness(); // 默认 restricted
  h.broker.execute({ ...h.base, command_id: 'cc-1', contract: h.contract() });
  h.broker.execute({ ...h.base, command_id: 'cc-2', contract: h.contract() });
  assert.throws(
    () => h.broker.execute({ ...h.base, command_id: 'cc-3', contract: h.contract() }),
    (e) => e.code === 'E_GATE_CONCURRENCY_LIMIT'
  );
});

test('wire 预算：超出节奏档上限被拒绝（restricted=1000）', () => {
  const h = harness();
  h.broker.execute({ ...h.base, command_id: 'wb-1', contract: h.contract({ wire_cost: 1000 }) });
  assert.throws(
    () => h.broker.execute({ ...h.base, command_id: 'wb-2', contract: h.contract({ wire_cost: 1 }) }),
    (e) => e.code === 'E_GATE_RATE_LIMIT' && /预算不足/.test(e.message)
  );
});

test('最小间隔：仅 stealth 档生效（8s 地板），冷却后可放行', () => {
  let now = 0;
  const h = harness({ authOverrides: { rhythm: 'stealth' }, nowMs: () => now });
  now = Date.now();
  h.broker.execute({ ...h.base, command_id: 'mi-1', contract: h.contract({ wire_cost: 1 }) });
  h.broker.cancel(h.eng.engagement_id, 'mi-1', 'test'); // 释放并发名额（stealth 并发=1）
  assert.throws(
    () => h.broker.execute({ ...h.base, command_id: 'mi-2', contract: h.contract({ wire_cost: 1 }) }),
    (e) => e.code === 'E_GATE_RATE_LIMIT' && typeof e.retry_after_ms === 'number'
  );
  now += 9000; // 越过 8s 地板（留出真实执行耗时余量）
  const ok = h.broker.execute({ ...h.base, command_id: 'mi-2', contract: h.contract({ wire_cost: 1 }) });
  assert.equal(ok.state, 'running');
});

test('open 档无最小间隔限制（批量流可用）', () => {
  const h = harness({ authOverrides: { rhythm: 'open' } });
  h.broker.execute({ ...h.base, command_id: 'op-1', contract: h.contract({ wire_cost: 1 }) });
  const ok = h.broker.execute({ ...h.base, command_id: 'op-2', contract: h.contract({ wire_cost: 1 }) });
  assert.equal(ok.state, 'running');
});

test('destructive：无令牌 / 伪造令牌 / 过期 / 跨战役 / 重复使用 全部拒绝', () => {
  const h = harness();
  const other = h.broker.createEngagement({ user_message_id: 'um-2', targets: ['10.0.0.0/24'] });
  const c = () => h.contract({ action_class: 'destructive' });

  assert.throws(
    () => h.broker.execute({ ...h.base, command_id: 'ap-1', contract: c() }),
    (e) => e.code === 'E_GATE_DESTRUCTIVE_NEEDS_APPROVAL'
  );
  assert.throws(
    () => h.broker.execute({ ...h.base, command_id: 'ap-2', contract: c(), manual_approval_token: 'ap_fake' }),
    (e) => e.code === 'E_APPROVAL_NOT_FOUND'
  );
  // 过期
  const expired = h.broker.createApproval({ engagement_id: h.eng.engagement_id, ttlSeconds: -1 });
  assert.throws(
    () => h.broker.execute({ ...h.base, command_id: 'ap-3', contract: c(), manual_approval_token: expired.approval_id }),
    (e) => e.code === 'E_APPROVAL_EXPIRED'
  );
  // 跨战役
  const forOther = h.broker.createApproval({ engagement_id: other.engagement_id });
  assert.throws(
    () => h.broker.execute({ ...h.base, command_id: 'ap-4', contract: c(), manual_approval_token: forOther.approval_id }),
    (e) => e.code === 'E_APPROVAL_MISMATCH'
  );
  // 正常 + 一次性复用被拒
  const good = h.broker.createApproval({ engagement_id: h.eng.engagement_id, reason: '授权内破坏性验证' });
  const ok = h.broker.execute({ ...h.base, command_id: 'ap-5', contract: c(), manual_approval_token: good.approval_id });
  assert.equal(ok.state, 'running');
  assert.throws(
    () => h.broker.execute({ ...h.base, command_id: 'ap-6', contract: c(), manual_approval_token: good.approval_id }),
    (e) => e.code === 'E_APPROVAL_USED'
  );
});

test('批准与节奏闸留痕：approvals 记录 used_by_command，gate_log 有 allow', () => {
  const h = harness();
  const ap = h.broker.createApproval({ engagement_id: h.eng.engagement_id, issued_by: 'operator-1' });
  h.broker.execute({ ...h.base, command_id: 'ap-log', contract: h.contract({ action_class: 'destructive' }), manual_approval_token: ap.approval_id });
  const row = h.broker.global.prepare('SELECT * FROM approvals WHERE approval_id = ?').get(ap.approval_id);
  assert.match(row.used_by_command, /^used_at:/);
  assert.equal(row.issued_by, 'operator-1');
  const log = h.store().db.prepare("SELECT COUNT(*) c FROM gate_log WHERE decision = 'allow'").get().c;
  assert.ok(log >= 1);
});
