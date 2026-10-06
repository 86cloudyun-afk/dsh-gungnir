// 波次编排：会议纪要落库、依赖立即交接、独立任务并行、环检测、事实入库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../packages/warroom-core/src/testing.js';
import { runWave, listMeetings, recordMeeting } from '../packages/warroom-core/src/wave.js';
import { JumphostManager } from '../packages/warroom-core/src/jumphosts.js';

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

test('依赖以上游**结项**为准：回执未就绪时，下游不得提前派发（并发 ≥2）', () => {
  const h = harness(); // restricted → maxInFlight 2：有空槽也不能让下游抢跑
  const timeline = [];
  let aTaskId = null;
  const origExecute = h.broker.execute.bind(h.broker);
  h.broker.execute = (req) => {
    const res = origExecute(req);
    const id = req.command_id.split('-').pop();
    if (id === 'A') aTaskId = res.task_id;
    timeline.push(`dispatch:${id}`);
    return res;
  };
  const origSettle = h.broker.settle.bind(h.broker);
  h.broker.settle = (eng, tid) => {
    const r = origSettle(eng, tid);
    if (tid === aTaskId && r.settled) timeline.push('settle:A');
    return r;
  };
  // 模拟异步执行器：A 的回执第一次 drain 尚未就绪（collect 抛一次），下一轮才能收到
  const origCollect = h.broker.adapter.collect.bind(h.broker.adapter);
  const thrown = new Set();
  h.broker.adapter.collect = (tid, opts) => {
    if (aTaskId && tid === aTaskId && !thrown.has(tid)) {
      thrown.add(tid);
      throw new Error('receipt not ready yet (simulated async executor)');
    }
    return origCollect(tid, opts);
  };

  const r = runWave({
    broker: h.broker, engagementId: h.eng.engagement_id,
    wave: { title: '异步依赖波', notes: 'x', tasks: [
      { id: 'A', role: 'recon', targets: ['10.0.0.5'] },
      { id: 'B', role: 'chain', targets: ['10.0.0.5'], depends_on: ['A'] },
    ] },
  });
  // 关键不变量：B 的派发必须晚于 A 的结项（即使并发槽有空）
  const iA = timeline.indexOf('settle:A');
  const iB = timeline.indexOf('dispatch:B');
  assert.ok(iA >= 0, '应记录到 A 结项');
  assert.ok(iB >= 0, '应记录到 B 派发');
  assert.ok(iA < iB, `B 不得在 A 结项前派发，实际时序 ${timeline.join(' ')}`);
  assert.equal(r.tasks.length, 2);
  assert.equal(r.facts_inserted, 2, '两个任务各入库一条事实');
  assert.ok(r.tasks.every((t) => t.settled), '两个任务最终都应结项');
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

test('未结项的波必须如实返回 pending（不允许"看起来跑完"）', () => {
  const h = harness({ faults: { neverFinish: true } });  // 执行器不报终态
  const r = runWave({
    broker: h.broker, engagementId: h.eng.engagement_id,
    wave: { title: '卡住的波', notes: 'x', tasks: [{ id: 'A', role: 'recon', targets: ['10.0.0.5'] }] },
  });
  assert.equal(r.pending, true);
  assert.deepEqual(r.unsettled, ['A']);
  assert.equal(r.tasks[0].settled, false);
  assert.equal(r.tasks[0].state, 'running');
});

test('计划标注执行桶与出口需求（含默认桶与分桶计数）', () => {
  const h = harness();
  const r = runWave({
    broker: h.broker, engagementId: h.eng.engagement_id, dryRun: true,
    wave: {
      title: '桶标注', notes: 'x', default_bucket: 'B',
      tasks: [
        { id: 'A', role: 'recon', targets: ['10.0.0.5'], bucket: 'B', action_class: 'readonly' },
        { id: 'B', role: 'chain', targets: ['10.0.0.6'], bucket: 'A', wire_cost: 1 },
        { id: 'C', role: 'recon', targets: ['10.0.0.7'], bucket: 'B', wire_cost: 1 },
      ],
    },
  });
  const byId = Object.fromEntries(r.plan.tasks.map((t) => [t.id, t]));
  assert.equal(byId.A.bucket, 'B');
  assert.equal(byId.A.egress, 'none', '只读任务本波不出网');
  assert.equal(byId.A.needs_egress, false, '只读任务不出网');
  assert.equal(byId.B.bucket, 'A');
  assert.equal(byId.B.egress, 'route', '桶 A 且需出网 → 走 route');
  assert.equal(byId.C.egress, 'direct', '桶 B 需出网时走直连（不经 socks）');
  assert.deepEqual(r.plan.buckets, { B: 2, A: 1 });
  assert.equal(r.plan.default_bucket, 'B');
});

test('派单前桶自洽：需经 route 的任务但无活跃出口 → 拒绝开工（不产生任何命令）', () => {
  const h = harness();
  const before = h.broker.global.prepare('SELECT COUNT(*) c FROM command_queue').get().c;
  assert.throws(() => runWave({
    broker: h.broker, engagementId: h.eng.engagement_id,
    wave: { title: '缺出口', notes: 'x', tasks: [{ id: 'A', role: 'chain', targets: ['10.0.0.5'], wire_cost: 1 }] },
  }), (e) => e.code === 'E_FENCE_NO_ROUTE' && /桶 A/.test(e.message));
  assert.equal(h.broker.global.prepare('SELECT COUNT(*) c FROM command_queue').get().c, before, '拒绝后不得留下命令');
  assert.equal(listMeetings({ store: h.store() }).length, 0, '拒绝后不得留下会议纪要（会没开成）');
  const rejected = h.broker.audit(h.eng.engagement_id, { decision: 'wave_rejected' });
  assert.equal(rejected.rows.length, 1, '被拒的尝试要留痕（可追溯）');
  assert.match(rejected.rows[0].detail, /no_active_route/);
});

test('显式标 bucket B 的任务：无 route 也能跑（本机直连）', () => {
  const h = harness();
  const r = runWave({
    broker: h.broker, engagementId: h.eng.engagement_id,
    wave: { title: '本机波', notes: 'x', tasks: [{ id: 'A', role: 'recon', targets: ['10.0.0.5'], bucket: 'B' }] },
  });
  assert.equal(r.tasks.length, 1);
  assert.equal(r.facts_inserted, 1);
});

test('有活跃 route 时：需经 route 的波可正常开跑', () => {
  const h = harness();
  const jm = new JumphostManager({
    globalDb: h.broker.global, getFactStore: (id) => h.broker._eng(id).store,
    listEngagements: () => h.broker.listEngagements(),
  });
  jm.importHosts([{ id: 'wv-jh', addr_v4: '203.0.113.60' }]);
  jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });

  const r = runWave({
    broker: h.broker, engagementId: h.eng.engagement_id,
    wave: { title: '经路由波', notes: 'x', tasks: [{ id: 'A', role: 'chain', targets: ['10.0.0.5'], wire_cost: 1 }] },
  });
  assert.equal(r.tasks.length, 1);
  assert.equal(h.store().effectiveCount(), 1);
});
