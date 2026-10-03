// 完成与资源收口的语义边界（ADR-009）：
//   · `done` 只表示"派下去的活干完了"，**从不**表示资源已停（ADR-003 D4 原语义不变）——
//     但完成时清单里还有活资源，必须留 `resources_outstanding` 审计信号，不许悄悄过去；
//   · 终态任务上的取消请求不许无副作用地回"已结束"：清单里还有活资源就真的去停 + 逐项证实
//     （全证实 → confirmed_stopped；未证实 → unresolved 进人工队列）。
// 全部离线：FakeAdapter + 真实探针资源（活 PID = 未收口；已消失的 PID = 已收口）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { harness } from '../packages/warroom-core/src/testing.js';
import { HostTaskRunner } from '../packages/warroom-plugin/src/host-tasks.js';

const parent = { session_id: 'evidence-parent', created_at: 1000 };
const GONE_PID = 4_000_000;   // 远超 pid_max：探针实测"已不存在"

/** 起一个真后台进程当"活资源"，收尾自动清掉。 */
function liveChild() {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  return { pid: child.pid, kill: () => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } } };
}

function mk({ resources = [], settleSession = false }) {
  const h = harness({ authOverrides: { rhythm: 'open' } });
  const r = h.broker.execute({ ...h.base, command_id: 'rc-1', contract: h.contract({ resources, wire_cost: 0 }) });
  // settleSession：会话侧先停掉（只改资源事实，不动账本状态），让清单只剩实测探针资源说话
  if (settleSession) h.adapter.tasks.get('rc-1').session_up = false;
  return { h, r };
}

/** 等进程真的消失（kill 是异步的，探针必须看到"已不存在"才算停止）。 */
async function waitGone(pid) {
  for (let i = 0; i < 50; i += 1) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}
const gateRows = (h, decision) => h.store().db.prepare('SELECT detail FROM gate_log WHERE decision = ?').all(decision);

test('完成结论不再沉默：done + 清单还有活资源 → 记 done 并留 resources_outstanding 审计信号', () => {
  const child = liveChild();
  try {
    const { h, r } = mk({ resources: [{ kind: 'process', id: 'child-live', pid: child.pid }], settleSession: true });
    h.adapter.collect(r.task_id);                     // 执行器"报完成"（adapter 状态 done）
    const s = h.broker.settle(h.eng.engagement_id, r.task_id);
    assert.equal(s.runtime_state, 'done', '执行器确实报完成');
    assert.equal(s.ledger_state, 'done', 'done 只表示活干完了（资源由取消/停止流程收口，ADR-003 D4）');
    assert.deepEqual(s.live, ['child-live'], '但必须把"还有活的资源"作为结论的一部分交出来');
    const gate = gateRows(h, 'resources_outstanding');
    assert.equal(gate.length, 1, '门闸日志必须留下 resources_outstanding（可审计，不是悄悄过去）');
    assert.match(gate[0].detail, /child-live/);
    assert.equal(gateRows(h, 'settle').length, 1, '结项信号保持原样（效率四段/时序归集认它）');
  } finally { child.kill(); }
});

test('资源全部收口时不留审计噪声（不误伤正常任务）', () => {
  const { h, r } = mk({ resources: [{ kind: 'process', id: 'child-gone', pid: GONE_PID }], settleSession: true });
  h.adapter.collect(r.task_id);
  const s = h.broker.settle(h.eng.engagement_id, r.task_id);
  assert.equal(s.ledger_state, 'done');
  assert.equal(s.settled, true);
  assert.equal(s.live, undefined);
  assert.equal(gateRows(h, 'resources_outstanding').length, 0);
});

test('终态任务上的取消：清单还有活资源 → 真的去停并逐项证实（不再直接回"已结束"）', async () => {
  const child = liveChild();
  try {
    const { h, r } = mk({ resources: [{ kind: 'process', id: 'child-live', pid: child.pid }], settleSession: true });
    h.broker._setCommandState('rc-1', 'done');        // 模拟"修复前就已成终态"的历史任务
    const out = h.broker.cancel(h.eng.engagement_id, r.task_id, 'stop leftovers');
    assert.equal(out.state, 'unresolved', '活资源未证实停止 → unresolved（人工/探针收口）');
    assert.equal(h.adapter.tasks.get('rc-1').cancel_reason, 'stop leftovers', '停止请求必须真的发下去');
    const gate = gateRows(h, 'cancel_after_terminal');
    assert.equal(gate.length, 1, '取消终态任务要留痕');
    assert.match(gate[0].detail, /child-live/);

    // 子进程真的没了之后：再取消一次 → 逐项证实 → confirmed_stopped
    child.kill();
    assert.equal(await waitGone(child.pid), true, '子进程应已消失');
    const second = h.broker.cancel(h.eng.engagement_id, r.task_id, 'confirm stop');
    assert.equal(second.state, 'confirmed_stopped', '资源实测消失后才允许 confirmed_stopped');
  } finally { child.kill(); }
});

test('终态任务上的取消：清单已收口 → 保持原语义（terminal:true，不产生副作用）', () => {
  const { h, r } = mk({ resources: [{ kind: 'process', id: 'child-gone', pid: GONE_PID }], settleSession: true });
  h.broker._setCommandState('rc-1', 'done');
  const adapterStateBefore = h.adapter.tasks.get('rc-1').state;
  const out = h.broker.cancel(h.eng.engagement_id, r.task_id, 'nothing to do');
  assert.deepEqual(out, { task_id: r.task_id, state: 'done', terminal: true, live: [] });
  assert.equal(h.adapter.tasks.get('rc-1').state, adapterStateBefore, '不该扰动已收口的任务');
  assert.equal(h.adapter.tasks.get('rc-1').cancel_reason, undefined, '不该给已收口的任务发停止请求');
  assert.equal(gateRows(h, 'cancel_after_terminal').length, 0);
});

test('宿主观测路径同规则：done 事件遇上活资源 → 记 done + resources_outstanding，事件序号照记', () => {
  const child = liveChild();
  const h = harness({ authOverrides: { rhythm: 'open' } });
  h.adapter.observe = () => null;
  h.broker.execute({
    ...h.base, command_id: 'rc-host',
    contract: h.contract({ resources: [{ kind: 'process', id: 'host-child', pid: child.pid }], wire_cost: 0 }),
  }, { deferDispatch: true, parent });
  h.broker.dispatchQueued('rc-host');
  h.adapter.tasks.get('rc-host').session_up = false;   // 会话侧已收口，只留实测探针资源
  const runner = new HostTaskRunner({ broker: h.broker, delivery: { deliver: async () => ({ status: 'pending' }) } });
  try {
    const cmd = h.broker._findCommand('rc-host');
    const owner = h.broker.global.prepare('SELECT * FROM task_owners WHERE command_id = ?').get('rc-host');
    h.broker.adapter.observe = () => ({
      generation: cmd.generation, event_seq: 1, state: 'done',
      receipt: { receipt_id: 'rcp-host-1', generation: cmd.generation, members: [], resources: [] },
    });
    runner._observe(cmd, owner);
    assert.equal(h.broker._findCommand('rc-host').state, 'done', 'done 表示活干完了');
    const ownerAfter = h.broker.global.prepare('SELECT last_event_seq FROM task_owners WHERE command_id = ?').get('rc-host');
    assert.equal(ownerAfter.last_event_seq, 1, '事件序号要照记');
    const gate = gateRows(h, 'resources_outstanding');
    assert.equal(gate.length, 1, '但完成时活资源必须留痕');
    assert.match(gate[0].detail, /host-child/);
  } finally { runner.close?.(); child.kill(); }
});

test('宿主观测路径：资源已收口的 done 事件仍记 done（不误伤）', () => {
  const h = harness({ authOverrides: { rhythm: 'open' } });
  h.adapter.observe = () => null;
  h.broker.execute({
    ...h.base, command_id: 'rc-host-2',
    contract: h.contract({ resources: [{ kind: 'process', id: 'host-gone', pid: GONE_PID }], wire_cost: 0 }),
  }, { deferDispatch: true, parent });
  h.broker.dispatchQueued('rc-host-2');
  h.adapter.tasks.get('rc-host-2').session_up = false;
  const runner = new HostTaskRunner({ broker: h.broker, delivery: { deliver: async () => ({ status: 'pending' }) } });
  try {
    const cmd = h.broker._findCommand('rc-host-2');
    const owner = h.broker.global.prepare('SELECT * FROM task_owners WHERE command_id = ?').get('rc-host-2');
    h.broker.adapter.observe = () => ({
      generation: cmd.generation, event_seq: 1, state: 'done',
      receipt: { receipt_id: 'rcp-host-2', generation: cmd.generation, members: [], resources: [] },
    });
    runner._observe(cmd, owner);
    assert.equal(h.broker._findCommand('rc-host-2').state, 'done');
    assert.equal(gateRows(h, 'resources_outstanding').length, 0);
  } finally { runner.close?.(); }
});
