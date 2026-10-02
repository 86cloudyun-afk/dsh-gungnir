// 超时治理（ADR-003 D3）：超时 → unknown，绝不自动重试；reconcile 才定论。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';

function ctx() {
  const home = mkdtempSync(join(tmpdir(), 'wr-timeout-'));
  const adapter = new FakeAdapter({ faults: { neverFinish: true } }); // 执行器不报终态
  let now = Date.now();
  const broker = new Broker({ home, adapter, nowMs: () => now });
  const eng = broker.createEngagement({ user_message_id: 'um-to', targets: ['10.0.0.0/24'], overrides: { rhythm: 'open' } });
  const contract = (over = {}) => ({
    targets: ['10.0.0.5'], action_class: 'active', resources: [], wire_cost: 0,
    fake_members: [{ entity_type: 'asset', source_id: 'to-1', revision_no: 1, content_hash: 'h-to', payload: {} }], ...over,
  });
  return { home, broker, adapter, eng, contract, tick: (ms) => { now += ms; } };
}

test('未超时不动作；超过阈值转 unknown（不留 running）', () => {
  const c = ctx();
  c.broker.execute({ engagement_id: c.eng.engagement_id, auth_version: 1, action_class: 'active', command_id: 'to-1', contract: c.contract() });

  const early = c.broker.sweepTimeouts(c.eng.engagement_id, { timeoutMs: 30 * 60 * 1000 });
  assert.equal(early.swept.length, 0, '未超时不应清扫');
  assert.equal(early.scanned, 1);

  c.tick(31 * 60 * 1000);
  const swept = c.broker.sweepTimeouts(c.eng.engagement_id, { timeoutMs: 30 * 60 * 1000 });
  assert.equal(swept.swept.length, 1);
  const st = c.broker.status(c.eng.engagement_id, 'to-1');
  assert.equal(st.ledger_state, 'unknown');
});

test('绝不自动重试：清扫不产生新命令、不重派任务', () => {
  const c = ctx();
  c.broker.execute({ engagement_id: c.eng.engagement_id, auth_version: 1, action_class: 'active', command_id: 'to-2', contract: c.contract() });
  c.tick(60 * 60 * 1000);
  c.broker.sweepTimeouts(c.eng.engagement_id, { timeoutMs: 1000 });
  const cmds = c.broker.global.prepare('SELECT COUNT(*) c FROM command_queue').get().c;
  assert.equal(cmds, 1, '不得因为超时产生第二条命令');
  const tasks = [...c.adapter.tasks.values()].length;
  assert.equal(tasks, 1, '不得重派');
});

test('清扫后 reconcile 依证据定论（探针已停 → done）', () => {
  const c = ctx();
  const ex = c.broker.execute({ engagement_id: c.eng.engagement_id, auth_version: 1, action_class: 'active', command_id: 'to-3', contract: c.contract() });
  c.tick(60 * 60 * 1000);
  c.broker.sweepTimeouts(c.eng.engagement_id, { timeoutMs: 1000 });

  const t = c.adapter.tasks.get('to-3');
  t.session_up = false;                     // 执行器消失了，资源也随之消失
  const rec = c.broker.reconcile(c.eng.engagement_id, ex.task_id);
  assert.ok(['done', 'partial'].includes(rec.state), `应可定论，实际 ${rec.state}`);
});

test('gate_log 留痕 + CLI sweep 可用', () => {
  const c = ctx();
  c.broker.execute({ engagement_id: c.eng.engagement_id, auth_version: 1, action_class: 'active', command_id: 'to-4', contract: c.contract() });
  c.tick(60 * 60 * 1000);
  c.broker.sweepTimeouts(c.eng.engagement_id, { timeoutMs: 1000 });
  const row = c.broker._eng(c.eng.engagement_id).store.db
    .prepare("SELECT COUNT(*) c FROM gate_log WHERE decision = 'timeout_to_unknown'").get();
  assert.equal(row.c, 1, 'gate_log 必须留痕');
});
