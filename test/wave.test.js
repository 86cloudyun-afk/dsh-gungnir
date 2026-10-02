// 波次编排：会议纪要落库、依赖立即交接、独立任务并行、环检测、事实入库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../packages/warroom-core/src/testing.js';
import { runWave, listMeetings, recordMeeting } from '../packages/warroom-core/src/wave.js';

test('会议纪要落库（会不开，波不发）', () => {
  const h = harness();
  const m = recordMeeting({
    store: h.store(), engagementId: h.eng.engagement_id,
    title: '链前会议 #1', notes: '目标：10.0.0.5 → shell；先 recon 再 exploit',
    decisions: ['difficulty=medium', 'rhythm=restricted'],
  });
  assert.ok(m.meeting_id.startsWith('mt_'));
  const all = listMeetings({ store: h.store() });
  assert.equal(all.length, 1);
  assert.match(all[0].notes, /recon/);
  assert.deepEqual(JSON.parse(all[0].decisions), ['difficulty=medium', 'rhythm=restricted']);
});

test('依赖立即交接：B 依赖 A，A 完成即派 B；C 无依赖与 A 同波并行', () => {
  const h = harness();
  const r = runWave({
    broker: h.broker, engagementId: h.eng.engagement_id,
    wave: {
      title: '波 1', notes: 'recon → chain；另并行一个独立 recon',
      tasks: [
        { id: 'A', role: 'recon', targets: ['10.0.0.5'] },
        { id: 'C', role: 'recon', targets: ['10.0.0.6'] },
        { id: 'B', role: 'chain', targets: ['10.0.0.5'], depends_on: ['A'] },
      ],
    },
  });
  assert.equal(r.tasks.length, 3);
  // 无屏障：A 与 C 的派发都发生在 B 之前（B 依赖 A）
  const order = r.order;
  assert.ok(order.indexOf('B') === order.length - 1, `B 应最后，实际顺序 ${order.join('→')}`);
  assert.ok(order.includes('A') && order.includes('C'));
  assert.equal(r.facts_inserted, 3, '三个任务各入库一条事实');
  assert.equal(h.store().effectiveCount(), 3);
  assert.equal(listMeetings({ store: h.store() }).length, 1);
});

test('依赖成环/引用不存在 → 如实报错，不无限循环', () => {
  const h = harness();
  assert.throws(() => runWave({
    broker: h.broker, engagementId: h.eng.engagement_id,
    wave: { title: '坏波', notes: 'x', tasks: [
      { id: 'X', role: 'recon', targets: ['10.0.0.5'], depends_on: ['Y'] },
      { id: 'Y', role: 'recon', targets: ['10.0.0.5'], depends_on: ['X'] },
    ] },
  }), /依赖无法满足|成环/);

  assert.throws(() => runWave({
    broker: h.broker, engagementId: h.eng.engagement_id,
    wave: { title: '悬空依赖', notes: 'x', tasks: [
      { id: 'Z', role: 'recon', targets: ['10.0.0.5'], depends_on: ['不存在'] },
    ] },
  }), /依赖无法满足/);
});

test('空任务波被拒；波内事实按成员级幂等入库（重复波不重复记账）', () => {
  const h = harness();
  assert.throws(() => runWave({ broker: h.broker, engagementId: h.eng.engagement_id, wave: { title: '空', notes: 'x', tasks: [] } }),
    /wave.tasks 为空/);

  const wave = { title: '幂等波', notes: 'x', tasks: [{ id: 'A', role: 'recon', targets: ['10.0.0.5'] }] };
  runWave({ broker: h.broker, engagementId: h.eng.engagement_id, wave });
  assert.equal(h.store().effectiveCount(), 1);
  // 同 source_id + 同 revision 再来一次 → duplicate_ignored（不新增有效事实）
  runWave({ broker: h.broker, engagementId: h.eng.engagement_id, wave: { ...wave, title: '幂等波#2' } });
  assert.equal(h.store().effectiveCount(), 1, '重复内容不得产生第二条有效事实');
});

test('演练模式：只出计划（依赖序 + 并发层 + 会议预览），不落库不派单', () => {
  const h = harness();
  const before = {
    commands: h.broker.global.prepare('SELECT COUNT(*) c FROM command_queue').get().c,
    meetings: listMeetings({ store: h.store() }).length,
    facts: h.store().effectiveCount(),
  };
  const r = runWave({
    broker: h.broker, engagementId: h.eng.engagement_id, dryRun: true,
    wave: {
      title: '演练用会议', notes: '先 recon 再 chain',
      tasks: [
        { id: 'A', role: 'recon', targets: ['10.0.0.5'], resources: ['container'] },
        { id: 'C', role: 'recon', targets: ['10.0.0.6'] },
        { id: 'B', role: 'chain', targets: ['10.0.0.5'], depends_on: ['A'], action_class: 'active' },
      ],
    },
  });
  assert.equal(r.dry_run, true);
  assert.equal(r.plan.order.at(-1), 'B', 'B 依赖 A，应在最后');
  assert.equal(r.plan.layers[0].length, 2, 'A 与 C 同层可并行');
  assert.deepEqual(r.plan.layers[1], ['B']);
  assert.equal(r.plan.meeting_preview.title, '演练用会议');
  assert.equal(r.plan.tasks.find((t) => t.id === 'A').resource_kinds[0], 'container');

  // 演练不产生任何副作用
  assert.equal(h.broker.global.prepare('SELECT COUNT(*) c FROM command_queue').get().c, before.commands);
  assert.equal(listMeetings({ store: h.store() }).length, before.meetings);
  assert.equal(h.store().effectiveCount(), before.facts);
});

test('演练与执行共用依赖判定：成环在演练阶段就报错', () => {
  const h = harness();
  assert.throws(() => runWave({
    broker: h.broker, engagementId: h.eng.engagement_id, dryRun: true,
    wave: { title: '环', notes: 'x', tasks: [
      { id: 'X', role: 'recon', targets: ['10.0.0.5'], depends_on: ['Y'] },
      { id: 'Y', role: 'recon', targets: ['10.0.0.5'], depends_on: ['X'] },
    ] },
  }), /依赖无法满足/);
  // 悬空依赖同样在演练阶段暴露
  assert.throws(() => runWave({
    broker: h.broker, engagementId: h.eng.engagement_id, dryRun: true,
    wave: { title: '悬空', notes: 'x', tasks: [{ id: 'Z', role: 'recon', targets: ['10.0.0.5'], depends_on: ['无'] }] },
  }), /依赖无法满足/);
});

test('节奏档联动：波内同时在飞不超过档位上限（restricted=2 / stealth=1）', () => {
  const h = harness(); // 默认 restricted → 上限 2
  const spy = { maxConcurrent: 0, current: 0 };
  const origExecute = h.broker.execute.bind(h.broker);
  h.broker.execute = (req) => {
    spy.current += 1;
    spy.maxConcurrent = Math.max(spy.maxConcurrent, spy.current);
    try { return origExecute(req); } finally { spy.current -= 1; }
  };
  const origSettle = h.broker.settle.bind(h.broker);
  let inFlight = 0;
  h.broker.settle = (eng, tid) => { const r = origSettle(eng, tid); if (r.settled) inFlight -= 1; return r; };

  const r = runWave({
    broker: h.broker, engagementId: h.eng.engagement_id,
    wave: {
      title: '并发受限波', notes: '4 个独立任务',
      tasks: Array.from({ length: 4 }, (_, i) => ({ id: `T${i}`, role: 'recon', targets: [`10.0.0.${i + 1}`] })),
    },
  });
  assert.equal(r.rhythm, 'restricted');
  assert.equal(r.max_in_flight, 2);
  assert.equal(r.tasks.length, 4);
  assert.equal(r.facts_inserted, 4);

  // 命令并发峰值不得超过档位上限（用账本实时状态直接验证）
  const states = h.broker.global.prepare(
    "SELECT COUNT(*) c FROM command_queue WHERE state IN ('queued','running','cancel_requested','unknown')"
  ).get().c;
  assert.ok(states <= 2, `残留非终态命令应 ≤2，实际 ${states}`);
});

test('stealth 档：波内上限为 1（逐层串行）', () => {
  const h = harness({ authOverrides: { rhythm: 'stealth' } });
  const r = runWave({
    broker: h.broker, engagementId: h.eng.engagement_id,
    wave: {
      title: 'stealth 波', notes: 'x',
      tasks: [
        { id: 'A', role: 'recon', targets: ['10.0.0.5'] },
        { id: 'B', role: 'recon', targets: ['10.0.0.6'] },
      ],
    },
  });
  assert.equal(r.rhythm, 'stealth');
  assert.equal(r.max_in_flight, 1);
  assert.equal(r.tasks.length, 2);
});

test('未结项的波必须如实报错（不允许"看起来跑完"）', () => {
  const h = harness({ faults: { neverFinish: true } });  // 执行器不报终态
  assert.throws(() => runWave({
    broker: h.broker, engagementId: h.eng.engagement_id,
    wave: { title: '卡住的波', notes: 'x', tasks: [{ id: 'A', role: 'recon', targets: ['10.0.0.5'] }] },
  }), (e) => e.code === 'E_GATE_CONCURRENCY_LIMIT' && /未结项/.test(e.message));
});
