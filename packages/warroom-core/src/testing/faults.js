// 故障注入矩阵（框架 §10）：把散落的异常场景收成一个可重复执行的矩阵。
// 覆盖：丢回包 / 乱序与重复回执 / 事实库写失败 / 进程残留 / 重启恢复 / 撤销跨重启。
import { mkdtempSync, writeFileSync, copyFileSync, rmSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Broker } from '../broker.js';
import { FakeAdapter } from '../adapters/fake.js';
import { JumphostManager } from '../jumphosts.js';
import { rehydrate } from '../rehydrate.js';
import { backupHome } from '../maintenance.js';
import { planFenceForEngagement } from '../fence.js';
import { renderHtml } from '../html.js';
import { openEngagementDb } from '../db.js';
import { ERR_SCHEMA_NEWER } from '../migrate.js';

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

  // ⑦ 备份恢复往返：备份 → 篡改 → 用备份覆盖 → 内容与备份一致、完整性 ok
  check('备份恢复往返 → 数据回到备份时点且完整性通过', () => {
    const c = ctx();
    const ex = c.broker.execute({ ...c.base, command_id: 'f-7', contract: c.contract() });
    c.broker.collect(c.eng.engagement_id, ex.task_id, c.adapter.collect(ex.task_id));
    const store = c.broker._eng(c.eng.engagement_id).store;
    assert(store.effectiveCount() === 1, '前置：应有一条有效事实');

    const bk = backupHome({ home: c.home, dest: join(c.home, 'bk-restore') });
    assert(bk.ok === bk.total, '备份必须全部成功');

    // 篡改：删掉事实行（模拟误操作）
    store.db.exec('DELETE FROM fact_members');
    assert(store.effectiveCount() === 0, '前置：篡改后应为空');

    // 恢复：用备份覆盖 fact.db（先关连接避免 WAL 干扰）
    c.broker._eng(c.eng.engagement_id).db.close();
    const rel = `engagements/${c.eng.engagement_id}/fact.db`;
    copyFileSync(join(bk.dest, rel), join(c.home, rel));
    const reopened = openEngagementDb(join(c.home, `engagements/${c.eng.engagement_id}`));
    const count = reopened.prepare('SELECT COUNT(*) c FROM fact_members WHERE active = 1').get().c;
    const verdict = reopened.prepare('PRAGMA integrity_check').get();
    reopened.close();
    assert(count === 1, `恢复后应有 1 条有效事实，实际 ${count}`);
    assert((verdict?.integrity_check ?? Object.values(verdict)[0]) === 'ok', '恢复后完整性必须 ok');
  });

  // ⑧ 密钥缺失：轮换后历史密钥被删 → 解密明确报错（不静默返回空）
  check('密钥缺失 → 解密明确报错（E_SECRET_KEY_INVALID）', () => {
    const c = ctx();
    const a = c.broker.secrets.put('fault-matrix-secret', { label: 'fm' });
    c.broker.secrets.grant(a.secret_ref, { engagement_id: c.eng.engagement_id, task_id: 't', purpose: 'p' });
    const rot = c.broker.secrets.rotateKey();
    const archived = join(c.home, 'secrets', 'keys', `${rot.old_key_id}.bin`);
    assert(existsSync(archived), '轮换应归档旧密钥');
    rmSync(archived);
    // 把该行改回旧 key_id，模拟"历史密文仍在、历史密钥丢失"
    c.broker.global.prepare('UPDATE secret_store SET key_id = ? WHERE secret_ref = ?').run(rot.old_key_id, a.secret_ref);
    let code = null;
    try { c.broker.secrets.resolve(a.secret_ref, { task_id: 't', purpose: 'p' }); }
    catch (e) { code = e.code; }
    assert(code === 'E_SECRET_KEY_INVALID', `应明确报密钥缺失，实际 ${code}`);
  });

  // ⑨ 非法配置：构造 Broker 直接抛错（不静默用默认值）
  check('非法配置 → 构造即失败（未知字段/非法取值）', () => {
    const c = ctx();
    const cfgPath = join(c.home, 'warroom.json');
    writeFileSync(cfgPath, JSON.stringify({ rhythm: 'turbo' }));
    let failed = false;
    try { new Broker({ home: c.home, adapter: new FakeAdapter() }); }
    catch (e) { failed = /rhythm 必须是/.test(e.message); }
    assert(failed, '非法 rhythm 应让 Broker 构造失败');
    writeFileSync(cfgPath, JSON.stringify({ unknown_field: 1 }));
    let failed2 = false;
    try { new Broker({ home: c.home, adapter: new FakeAdapter() }); }
    catch (e) { failed2 = /未知字段/.test(e.message); }
    assert(failed2, '未知字段应让 Broker 构造失败');
    rmSync(cfgPath);
  });

  // ⑩ 高版本库：拒绝打开（防降级写坏数据）
  check('高版本库 → 拒绝打开（E_SCHEMA_NEWER_THAN_CODE）', () => {
    const c = ctx();
    c.broker._eng(c.eng.engagement_id).db.close();
    const dbPath = join(c.home, `engagements/${c.eng.engagement_id}/fact.db`);
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE meta SET v = '999' WHERE k = 'schema_version:fact'").run();
    raw.close();
    let code = null;
    try { openEngagementDb(join(c.home, `engagements/${c.eng.engagement_id}`)); }
    catch (e) { code = e.code; }
    assert(code === ERR_SCHEMA_NEWER, `应报 ${ERR_SCHEMA_NEWER}，实际 ${code}`);
  });

  // ⑪ 迁移补齐：老库缺表 → 重新打开自动补齐且可继续作业
  check('迁移补齐 → 老库缺表自动补建且可继续作业', () => {
    const c = ctx();
    const g = c.broker.global;
    g.exec('DROP TABLE IF EXISTS secret_store; DROP TABLE IF EXISTS secret_grants;');
    g.prepare("UPDATE meta SET v = '1' WHERE k = 'schema_version:global'").run();
    const broker2 = new Broker({ home: c.home, adapter: new FakeAdapter() });
    const put = broker2.secrets.put('after-migration', { label: 'm' });
    broker2.secrets.grant(put.secret_ref, { engagement_id: c.eng.engagement_id, task_id: 't', purpose: 'p' });
    const val = broker2.secrets.resolve(put.secret_ref, { task_id: 't', purpose: 'p' }).value;
    assert(val === 'after-migration', '迁移后应可正常登记与解析秘密');
  });

  // ⑫ 路由失效 → 围栏拒绝出计划（出口必须来自活跃 route）
  check('路由失效 → 围栏拒绝（E_FENCE_NO_ROUTE）', () => {
    const c = ctx();
    const self = c;
    const jm = new JumphostManager({
      globalDb: c.broker.global,
      getFactStore: (id) => c.broker._eng(id).store,
      listEngagements: () => c.broker.listEngagements(),
    });
    jm.importHosts([{ id: 'fm-jh', addr_v4: '203.0.113.30' }]);
    const acq = jm.acquire({ engagement_id: c.eng.engagement_id, target: '10.0.0.5' });
    const store = c.broker._eng(c.eng.engagement_id).store;

    // 收口后：不再有活跃出口
    jm.releaseRoute({ route_id: acq.route_id, engagementId: c.eng.engagement_id });
    let code = null;
    try { planFenceForEngagement({ store, engagementId: c.eng.engagement_id }); }
    catch (e) { code = e.code; }
    assert(code === 'E_FENCE_NO_ROUTE', `应拒绝出计划，实际 ${code}`);
    void self;
  });

  // ⑬ 长任务心跳失效 → unknown（基准为心跳，不是派发时刻）
  check('心跳失效 → unknown（基准 heartbeat）', () => {
    let t = Date.now();
    const home = mkdtempSync(join(tmpdir(), 'wr-fault-hb-'));
    const broker = new Broker({ home, adapter: new FakeAdapter({ faults: { neverFinish: true } }), nowMs: () => t });
    const eng = broker.createEngagement({ user_message_id: 'um-f13', targets: ['10.0.0.0/24'], overrides: { rhythm: 'open' } });
    const ex = broker.execute({
      command_id: 'f-13', engagement_id: eng.engagement_id, auth_version: 1, action_class: 'active',
      contract: { targets: ['10.0.0.5'], action_class: 'active', resources: [], wire_cost: 0,
        fake_members: [{ entity_type: 'asset', source_id: 'f13', revision_no: 1, content_hash: 'h', payload: {} }] },
    });
    t += 10 * 60 * 1000;
    broker.heartbeat(eng.engagement_id, ex.task_id);
    t += 31 * 60 * 1000;   // 心跳后再无进展
    const swept = broker.sweepTimeouts(eng.engagement_id, { timeoutMs: 30 * 60 * 1000 });
    assert(swept.swept.length === 1, '超过阈值应被清扫');
    assert(swept.swept[0].since === 'heartbeat', `基准应为心跳，实际 ${swept.swept[0].since}`);
    assert(broker.status(eng.engagement_id, ex.task_id).ledger_state === 'unknown', '应转 unknown');
  });

  // ⑭ 知识库未脱敏 → 拒绝入库（E_KB_UNSANITIZED）
  check('知识库未脱敏 → 拒绝入库（E_KB_UNSANITIZED）', () => {
    const c = ctx();
    let code = null;
    try {
      c.broker.knowledge.addPoc({
        code: 'F14-LEAK', title: '带内网地址的 POC', category: 'other',
        body: '请求 http://192.168.10.7/admin 返回 200',   // 未脱敏内容必须被拦
      });
    } catch (e) { code = e.code; }
    assert(code === 'E_KB_UNSANITIZED', `应拒绝未脱敏内容，实际 ${code}`);
    // 合规内容可入库
    const ok = c.broker.knowledge.addPoc({
      code: 'F14-OK', title: '已脱敏 POC', category: 'other', body: '请求 http://TARGET/admin 返回 200',
    });
    assert(ok.code === 'F14-OK', '合规内容应可入库');
  });

  // ⑮ 交付物边界：客户版文件不得含审计明细；HTML 不得引外部资源
  check('交付物边界 → 客户版无审计明细、HTML 无外部资源', () => {
    const c = ctx();
    const ex = c.broker.execute({ ...c.base, command_id: 'f-15', contract: c.contract() });
    c.broker.collect(c.eng.engagement_id, ex.task_id, c.adapter.collect(ex.task_id));
    const full = c.broker.exportReport(c.eng.engagement_id, { format: 'all' });
    const client = c.broker.exportReport(c.eng.engagement_id, { format: 'html', audience: 'client' });

    const clientHtml = readFileSync(client.paths.html, 'utf8');
    assert(!clientHtml.includes('审计摘要'), '客户版不得含审计明细');
    assert(!/<link[^>]+href|<script[^>]+src/.test(clientHtml), 'HTML 不得引外部 link/script');

    const fullHtml = readFileSync(full.paths.html, 'utf8');
    assert(/^<!doctype html>/.test(fullHtml), 'HTML 应为完整文档');
    assert(fullHtml.includes('水位'), '全量 HTML 应含水位段');
  });

  // ⑯ 证据落盘边界：客户版目录与索引都不含明文秘密
  check('证据落盘边界 → 索引与客户版均无明文', () => {
    const c = ctx();
    const plain = 'fault-matrix-plain-2211';
    const sec = c.broker.secrets.put(plain, { label: 'fm-plain' });
    const ex = c.broker.execute({
      ...c.base, command_id: 'f-16',
      contract: c.contract({
        fake_members: [{ entity_type: 'credential', source_id: 'c-f16', revision_no: 1, content_hash: 'h16', payload: { password: plain } }],
      }),
    });
    c.broker.collect(c.eng.engagement_id, ex.task_id, c.adapter.collect(ex.task_id));
    const ev = c.broker.exportEvidence(c.eng.engagement_id, { outDir: join(c.home, 'ev-f16'), audiences: ['client'] });
    const index = readFileSync(ev.files.index, 'utf8');
    assert(!index.includes(plain), '索引不得含明文秘密');
    const clientMd = readFileSync(ev.audience_files[0].markdown, 'utf8');
    assert(!clientMd.includes(plain), '客户版不得含明文秘密');
    const fullMd = readFileSync(ev.files.markdown, 'utf8');
    assert(!fullMd.includes(plain), '内部全量同样脱敏');
    assert(sec.secret_ref.startsWith('sec_'), '秘密应只以引用存在');
  });

  const failed = checks.filter((x) => !x.ok);
  return { total: checks.length, passed: checks.length - failed.length, failed, checks: [...checks] };
}
