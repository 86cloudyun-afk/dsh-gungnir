// 故障注入矩阵（框架 §10）：把散落的异常场景收成一个可重复执行的矩阵。
// 覆盖：丢回包 / 乱序与重复回执 / 事实库写失败 / 进程残留 / 重启恢复 / 撤销跨重启。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from '../broker.js';
import { FakeAdapter } from '../adapters/fake.js';
import { JumphostManager } from '../jumphosts.js';
import { rehydrate } from '../rehydrate.js';

const mem = (entity, sid, rev, hash) => ({ entity_type: entity, source_id: sid, revision_no: rev, content_hash: hash, payload: {} });

function ctx({ faults = {}, authOverrides = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wr-fault-'));
  const adapter = new FakeAdapter({ faults });
  const broker = new Broker({ home, adapter });
  const eng = broker.createEngagement({ user_message_id: 'fault-um', targets: ['10.0.0.0/24'], overrides: authOverrides });
  const base = { engagement_id: eng.engagement_id, auth_version: eng.auth_version };
  const contract = (over = {}) => ({
    targets: ['10.0.0.5'], action_class: 'active', resources: [], wire_cost: 0,
    fake_members: [mem('asset', 'fa-1', 1, 'h1')], ...over,
  });
  return { home, adapter, broker, eng, base, contract };
}

const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push({ name, ok: true, detail: '' }); }
  catch (e) { checks.push({ name, ok: false, detail: String(e.message || e) }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

export function runFaultMatrix() {
  checks.length = 0;

  // ① 丢回包：unknown 不是失败；lookup 找回；对账定论
  check('丢回包 → unknown → lookup 找回 → reconcile 定论', () => {
    const c = ctx({ faults: { loseResponse: true } });
    const r = c.broker.execute({ ...c.base, command_id: 'f-1', contract: c.contract() });
    assert(r.state === 'unknown', `状态应为 unknown，实际 ${r.state}`);
    const found = c.adapter.lookup('f-1');
    assert(found && found.task_id === r.task_id, 'lookup 应找回同一任务');
    c.adapter.tasks.get('f-1').session_up = false;
    const rec = c.broker.reconcile(c.eng.engagement_id, r.task_id);
    assert(rec.state === 'done', `对账应定论 done，实际 ${rec.state}`);
    assert([...c.adapter.tasks.values()].length === 1, '不得产生第二个任务');
  });

  // ② 乱序与重复回执：成员级幂等保证账不重复、旧修订不覆盖
  check('乱序回执 + 重复回执 → 成员级幂等（不重复记账、旧修订不覆盖）', () => {
    const c = ctx();
    const ex = c.broker.execute({ ...c.base, command_id: 'f-2', contract: c.contract() });
    // 先收 {A,B}（顺序打乱），再收 {A}（重复），最后收 A 的低修订
    const shuffled = [mem('asset', 'fa-2', 1, 'h2'), mem('asset', 'fa-1', 1, 'h1')];
    c.broker.collect(c.eng.engagement_id, ex.task_id, c.adapter.collect(ex.task_id, { receipt_id: 'r1', members: shuffled }));
    c.broker.collect(c.eng.engagement_id, ex.task_id, c.adapter.collect(ex.task_id, { receipt_id: 'r2', members: [mem('asset', 'fa-1', 1, 'h1')] }));
    const r3 = c.broker.collect(c.eng.engagement_id, ex.task_id, c.adapter.collect(ex.task_id, { receipt_id: 'r3', members: [mem('asset', 'fa-1', 0, 'h0')] }));
    const store = c.broker._eng(c.eng.engagement_id).store;
    assert(store.effectiveCount() === 2, `有效事实应为 2，实际 ${store.effectiveCount()}`);
    assert(r3.results.some((x) => x.action === 'late_revision_ignored'), '低修订应被忽略');
  });

  // ③ 事实库写失败：op_log 补偿 + 恢复后审计回填
  check('事实库写失败 → op_log 补偿 → 恢复后审计回填', () => {
    const c = ctx();
    const store = c.broker._eng(c.eng.engagement_id).store;
    const jm = new JumphostManager({ globalDb: c.broker.global, getFactStore: () => store });
    jm.importHosts([{ id: 'fj-1', addr_v4: '203.0.113.1' }]);
    store.faults.write_fail = true;
    let compensated = false;
    try { jm.acquire({ engagement_id: c.eng.engagement_id, target: '10.0.0.5' }); }
    catch (e) { compensated = e.code === 'E_COMPENSATED'; }
    assert(compensated, '应走补偿路径');
    assert(c.broker.global.prepare("SELECT state FROM leases WHERE jumphost_id='fj-1'").get().state === 'released', '租约应释放');
    store.faults.write_fail = false;
    store.backfillEgressCheck({ jumphost_id: 'fj-1', exit_ip: '203.0.113.1', verdict: 'pass', route_id: 'bf-1' });
    assert(store.db.prepare("SELECT recovered_at FROM egress_checks WHERE route_id='bf-1'").get().recovered_at, '应带回填标记');
  });

  // ④ 进程残留：不得 confirmed_stopped；清残留后逐项证实
  check('进程残留 → unresolved（不得假称已停止）→ 清残留后 confirmed_stopped', () => {
    const c = ctx({ faults: { containerResidue: true } });
    const r = c.broker.execute({ ...c.base, command_id: 'f-4', contract: c.contract({ resources: ['container'] }) });
    const first = c.broker.cancel(c.eng.engagement_id, r.task_id, 'fault');
    assert(first.state === 'unresolved', `应 unresolved，实际 ${first.state}`);
    c.adapter.faults.containerResidue = false;
    const second = c.broker.cancel(c.eng.engagement_id, r.task_id, 'fault');
    assert(second.state === 'confirmed_stopped', `清残留后应 confirmed_stopped，实际 ${second.state}`);
  });

  // ⑤ 重启恢复：新进程（Broker+Adapter 全新）经再水化继续作业
  check('重启恢复 → 再水化 → 账本态保留且可继续操作', () => {
    const c = ctx();
    const r = c.broker.execute({ ...c.base, command_id: 'f-5', contract: c.contract() });
    // 模拟重启：全新 Broker / Adapter 指向同一 home
    const broker2 = new Broker({ home: c.home, adapter: new FakeAdapter() });
    const { hydrated } = rehydrate(broker2);
    assert(hydrated === 1, `应再水化 1 个任务，实际 ${hydrated}`);
    const st = broker2.status(c.eng.engagement_id, r.task_id);
    assert(st.ledger_state === 'running', `账本态应保留，实际 ${st.ledger_state}`);
    const collected = broker2.collect(c.eng.engagement_id, r.task_id, broker2.adapter.collect(r.task_id));
    assert(collected.accepted === true, '重启后应可继续回收执');
  });

  // ⑥ 撤销跨重启：旧 auth_version 永久失效
  check('撤销跨重启 → 旧 auth_version 被拒', () => {
    const c = ctx();
    c.broker.revoke(c.eng.engagement_id, 'fault-matrix');
    const broker2 = new Broker({ home: c.home, adapter: new FakeAdapter() });
    rehydrate(broker2);
    let rejected = false;
    try {
      broker2.execute({ ...c.base, command_id: 'f-6', contract: c.contract() });
    } catch (e) { rejected = e.code === 'E_GATE_AUTH_EXPIRED'; }
    assert(rejected, '撤销后旧版本必须被拒');
  });

  const failed = checks.filter((x) => !x.ok);
  return { total: checks.length, passed: checks.length - failed.length, failed, checks: [...checks] };
}
