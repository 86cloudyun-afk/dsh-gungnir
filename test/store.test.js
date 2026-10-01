// 成员级幂等 / 乱序修订 / 代际隔离 / 水位 / 只读连接 / 计量（ADR-002 rev2 验收）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { harness } from '../packages/warroom-core/src/testing.js';
import { openReadOnly } from '../packages/warroom-core/src/db.js';

test('{A} → {A,B} 集合扩张不重复记账；重复回执全部 duplicate_ignored', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 's1', contract: h.contract() });
  const r1 = h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  assert.equal(r1.accepted, true);
  assert.equal(h.store().effectiveCount(), 1);

  const members2 = [
    ...h.adapter.tasks.get('s1').members,
    { entity_type: 'asset', source_id: 'a-2', revision_no: 1, content_hash: 'h-a2', payload: { ip: '10.0.0.6' } },
  ];
  h.broker.collect(h.eng.engagement_id, ex.task_id,
    h.adapter.collect(ex.task_id, { receipt_id: 'rcp-x2', members: members2 }));
  assert.equal(h.store().effectiveCount(), 2);

  // 同一批成员重复提交 → 全部 duplicate_ignored
  const r3 = h.broker.collect(h.eng.engagement_id, ex.task_id,
    h.adapter.collect(ex.task_id, { receipt_id: 'rcp-x2', members: members2 }));
  assert.ok(r3.results.every((x) => x.action === 'duplicate_ignored'));
  assert.equal(h.store().effectiveCount(), 2);
});

test('乱序修订：晚到的旧 revision_no 不覆盖新修订、不重复记账；同号异容进冲突待审', () => {
  const h = harness();
  const store = h.store();
  const m = (rev, hash) => ({ entity_type: 'vuln', source_id: 'v-1', revision_no: rev, content_hash: hash, payload: { rev } });
  const ing = (mm) => store.ingestMembers({ adapterInstance: 'x', members: mm, generation: '1:1:1' });

  ing([m(2, 'h2')]);
  assert.equal(store.effectiveCount(), 1);
  const late = ing([m(1, 'h1')]).results[0];
  assert.equal(late.action, 'late_revision_ignored');
  assert.equal(store.effectiveCount(), 1);
  const sup = ing([m(3, 'h3')]).results[0];
  assert.equal(sup.action, 'superseded');
  assert.equal(store.effectiveCount(), 1); // 仍一行有效，历史行保留
  const conf = ing([m(3, 'h3-different')]).results[0];
  assert.equal(conf.action, 'conflict_review');
  assert.equal(store.effectiveCount(), 1);
});

test('代际隔离：不匹配 generation 的回执整体进隔离区', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 's2', contract: h.contract() });
  const receipt = h.adapter.collect(ex.task_id, { generation: '9:9:9' });
  const r = h.broker.collect(h.eng.engagement_id, ex.task_id, receipt);
  assert.equal(r.accepted, false);
  assert.equal(r.quarantined, 'generation');
  assert.equal(h.store().effectiveCount(), 0);
  const stale = h.store().db.prepare("SELECT COUNT(*) c FROM fact_members WHERE flags = 'stale_generation'").get().c;
  assert.equal(stale, 1);
});

test('水位双校验：seq 单调、snapshot 变化、导出后新写入不在旧快照', () => {
  const h = harness();
  const store = h.store();
  const w1 = store.exportSnapshot();
  assert.equal(w1.rows.length, 0);
  const ex = h.broker.execute({ ...h.base, command_id: 's3', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  const w2 = store.exportSnapshot();
  assert.ok(w2.seq > w1.seq);
  assert.notEqual(w2.snapshot_id, w1.snapshot_id);
  assert.equal(w1.rows.length, 0);
  assert.equal(w2.rows.length, 1);
});

test('计量：wire_requests 与 tool_calls 分开计数（一次工具调用可含多次请求）', () => {
  const h = harness();
  h.broker.execute({ ...h.base, command_id: 's4', contract: h.contract({ wire_cost: 5 }) });
  assert.equal(h.store().rateTotal('wire'), 5);
  assert.equal(h.store().rateTotal('tool'), 1);
});

test('只读连接写被拒绝（写所有权由访问控制实现，ADR-002 D9）', () => {
  const h = harness();
  const dbPath = join(h.home, 'engagements', h.eng.engagement_id, 'fact.db');
  const ro = openReadOnly(dbPath);
  assert.throws(
    () => ro.exec("INSERT INTO gate_log (ts, decision) VALUES ('2026-01-01', 'deny')"),
    /readonly/i
  );
});
