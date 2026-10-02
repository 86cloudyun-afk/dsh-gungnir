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
