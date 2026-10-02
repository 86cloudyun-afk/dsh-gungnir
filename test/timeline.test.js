// 战役时序：事件排序、相位归集、跨度计算；缺失阶段如实标 pending。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { harness } from '../packages/warroom-core/src/testing.js';
import { renderTimeline } from '../packages/warroom-core/src/timeline.js';

test('时序归集：立项/派发/回执/结项/控制面各就各位且按时间排序', () => {
  const h = harness();
  const store = h.store();
  const T0 = Date.parse('2026-10-01T00:00:00.000Z');
  store.db.prepare('UPDATE engagements SET created_at = ? WHERE id = ?').run(new Date(T0).toISOString(), h.eng.engagement_id);

  const ex = h.broker.execute({ ...h.base, command_id: 'tl-1', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  h.broker.settle(h.eng.engagement_id, ex.task_id);
  store.recordShellProof({ proof: 'shell-tl', evidence_ref: 'ev' });

  // 重排时间戳，验证排序与跨度
  h.broker.global.prepare('UPDATE command_queue SET ts = ? WHERE task_id = ?').run(new Date(T0 + 5000).toISOString(), ex.task_id);
  const collectRow = store.db.prepare("SELECT id FROM gate_log WHERE decision='collect'").get();
  store.db.prepare('UPDATE gate_log SET ts = ? WHERE id = ?').run(new Date(T0 + 9000).toISOString(), collectRow.id);
  const settleRow = store.db.prepare("SELECT id FROM gate_log WHERE decision='settle'").get();
  store.db.prepare('UPDATE gate_log SET ts = ? WHERE id = ?').run(new Date(T0 + 20000).toISOString(), settleRow.id);
  const proofRow = store.db.prepare("SELECT id FROM gate_log WHERE decision='shell_proof'").get();
  store.db.prepare('UPDATE gate_log SET ts = ? WHERE id = ?').run(new Date(T0 + 30000).toISOString(), proofRow.id);

  const tl = h.broker.timeline(h.eng.engagement_id);
  const stamped = tl.events.filter((e) => e.ts);
  assert.deepEqual(stamped.map((e) => e.phase), [...stamped].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).map((e) => e.phase),
    '事件必须按时间升序');
  assert.equal(tl.phases['立项'].first_at, new Date(T0).toISOString());
  assert.equal(tl.phases['派发'].first_at, new Date(T0 + 5000).toISOString());
  assert.equal(tl.phases['回执'].first_at, new Date(T0 + 9000).toISOString());
  assert.equal(tl.phases['结项'].count >= 1, true);
  assert.equal(tl.phases['控制面'].first_at, new Date(T0 + 30000).toISOString());
  assert.equal(tl.span_ms, 30000);
});

test('缺失阶段如实反映：新战役只有立项与派发，其余 first_at 为 null', () => {
  const h = harness();
  h.broker.execute({ ...h.base, command_id: 'tl-2', contract: h.contract() });
  const tl = h.broker.timeline(h.eng.engagement_id);
  assert.ok(tl.phases['立项'].count >= 1);
  assert.equal(tl.phases['回执'].first_at, null);
  assert.equal(tl.phases['控制面'].first_at, null);
  assert.equal(tl.phases['交付'].count, 0);
  assert.equal(tl.events.some((e) => e.kind === 'ledger_state:running'), true, '账本态事件应带 state');
});

test('文本渲染：等宽表含表头与阶段名', () => {
  const h = harness();
  h.broker.execute({ ...h.base, command_id: 'tl-3', contract: h.contract() });
  const text = renderTimeline(h.broker.timeline(h.eng.engagement_id));
  assert.match(text, /战役时序：eng_/);
  assert.match(text, /时间\(UTC\)/);
  assert.match(text, /派发/);
});

test('CLI timeline 文本与 json 双路可用', () => {
  const h = harness();
  h.broker.execute({ ...h.base, command_id: 'tl-4', contract: h.contract() });
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  const text = execFileSync('node', ['bin/warroom.mjs', 'timeline', '--engagement', h.eng.engagement_id, '--home', h.home, '--text'],
    { encoding: 'utf8', env });
  assert.match(text, /战役时序/);
  const parsed = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'timeline', '--engagement', h.eng.engagement_id, '--home', h.home, '--json'],
    { encoding: 'utf8', env }));
  assert.ok(Array.isArray(parsed.events));
});
