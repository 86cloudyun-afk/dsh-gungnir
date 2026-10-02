// 时序分段视图：逐任务 派发→回执→结项 与耗时；缺时间戳不编造；ASCII 条按最大段缩放。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness } from '../packages/warroom-core/src/testing.js';
import { buildGantt, renderGantt } from '../packages/warroom-core/src/gantt.js';

test('从时序事件重建逐任务分段并缩放条长', () => {
  const timeline = { events: [
    { ts: '2026-10-01T00:00:00.000Z', phase: '派发', kind: 'dispatch', detail: '任务 wt_aaa（attempt 1）' },
    { ts: '2026-10-01T00:00:10.000Z', phase: '回执', kind: 'collect', detail: '{"task_id":"wt_aaa","accepted":true,"seq":1}' },
    { ts: '2026-10-01T00:00:40.000Z', phase: '结项', kind: 'settle', detail: '{"task_id":"wt_aaa","state":"done"}' },
    { ts: '2026-10-01T00:01:00.000Z', phase: '派发', kind: 'dispatch', detail: '任务 wt_bbb（attempt 1）' },
    { ts: '2026-10-01T00:01:05.000Z', phase: '回执', kind: 'collect', detail: '{"task_id":"wt_bbb","accepted":true,"seq":2}' },
    { ts: null, phase: '结项', kind: 'ledger_state:running', detail: '任务 wt_bbb 当前账本态 running' },
  ] };
  const g = buildGantt(timeline);
  assert.equal(g.tasks.length, 2);
  const a = g.tasks.find((t) => t.task_id === 'wt_aaa');
  const b = g.tasks.find((t) => t.task_id === 'wt_bbb');
  assert.equal(a.handoff_ms, 10000);
  assert.equal(a.exec_ms, 30000);
  assert.equal(a.settled_at, '2026-10-01T00:00:40.000Z');
  assert.equal(b.handoff_ms, 5000);
  assert.equal(b.exec_ms, null, '未结项 → 执行段为 null（不编造）');
  assert.equal(g.scale_ms, 30000);
  assert.ok(a.bar_exec.length >= b.bar_handoff.length, '按最大段缩放：长的条不短于短的');
  assert.match(g.note, /不编/);
});

test('dispatch 事件缺 task_id 时该事件被忽略（不造出假任务）', () => {
  const g = buildGantt({ events: [{ ts: '2026-10-01T00:00:00Z', phase: '派发', kind: 'dispatch', detail: '（无 task_id）' }] });
  assert.equal(g.tasks.length, 0);
});

test('报告收录时序段：md 有表与条，JSON 有 timing.tasks', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'gantt-1', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  h.broker.settle(h.eng.engagement_id, ex.task_id);

  const r = h.broker.exportReport(h.eng.engagement_id, { format: 'both' });
  const md = readFileSync(r.paths.markdown, 'utf8');
  assert.match(md, /## 时序与分段/);
  assert.match(md, /条（交接 \/ 执行）/);
  assert.match(md, /条长按最大分段/);

  const json = JSON.parse(readFileSync(r.paths.json, 'utf8'));
  assert.equal(json.timing.tasks.length, 1);
  assert.equal(json.timing.tasks[0].task_id, ex.task_id);
  assert.equal(typeof json.timing.span_ms, 'number');
  assert.ok(json.timing.phases['立项']);
});

test('未结项的任务也出现在表里（如实显示 —）', () => {
  const h = harness({ faults: { neverFinish: true } });
  h.broker.execute({ ...h.base, command_id: 'gantt-2', contract: h.contract() });
  const r = h.broker.exportReport(h.eng.engagement_id, { format: 'md' });
  const md = readFileSync(r.paths.markdown, 'utf8');
  assert.match(md, /## 时序与分段/);
  const g = buildGantt(h.broker.timeline(h.eng.engagement_id));
  assert.equal(g.tasks.length, 1);
  assert.equal(g.tasks[0].settled_at, null);
  assert.match(renderGantt(g), /—/);
});
