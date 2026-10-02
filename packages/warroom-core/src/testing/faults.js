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

/**
 * 场景清单（供文档与外部评审）：name 必须与实现里的 check(...) 名称**逐字一致**，
 * 由 test/fault-matrix.test.js 断言（清单与实现漂移即失败）。
 */
export const SCENARIOS = Object.freeze([
  { n: 1, name: '丢回包 → unknown → lookup 找回 → reconcile 定论', expects: '执行层回执丢失时不丢任务：账本记 unknown，可按 command_id 找回，依证据定论', contract: 'ADR-002 D3 / ADR-003 D5' },
  { n: 2, name: '乱序回执 + 重复回执 → 成员级幂等（不重复记账、旧修订不覆盖）', expects: '同一成员重复/乱序回执不产生第二条有效事实，低修订不覆盖高修订', contract: 'ADR-002 D5' },
  { n: 3, name: '事实库写失败 → op_log 补偿 → 恢复后审计回填', expects: '写失败不静默：intent 先落 op_log，恢复后审计补齐', contract: 'ADR-002 D6' },
  { n: 4, name: '进程残留 → unresolved（不得假称已停止）→ 清残留后 confirmed_stopped', expects: '停止证明必须实测：残留即 unresolved，清理后才 confirmed', contract: 'ADR-003 D4' },
  { n: 5, name: '重启恢复 → 再水化 → 账本态保留且可继续操作', expects: '重启后账本态与执行层视图重新对齐，任务可继续', contract: 'ADR-003 D5/D6' },
  { n: 6, name: '撤销跨重启 → 旧 auth_version 被拒', expects: '授权撤销跨进程有效：旧版本请求一律拒绝', contract: 'ADR-001 D3' },
  { n: 7, name: '备份恢复往返 → 数据回到备份时点且完整性通过', expects: '备份可用于真实恢复；恢复后完整性与内容一致', contract: '框架 §10 数据治理' },
  { n: 8, name: '密钥缺失 → 解密明确报错（E_SECRET_KEY_INVALID）', expects: '密钥丢失必须显式失败，不得静默返回空值', contract: 'ADR-001 D7' },
  { n: 9, name: '非法配置 → 构造即失败（未知字段/非法取值）', expects: '配置错误立即暴露，不静默用默认值', contract: '框架 §7' },
  { n: 10, name: '高版本库 → 拒绝打开（E_SCHEMA_NEWER_THAN_CODE）', expects: '库版本高于代码即拒绝，防降级写坏数据', contract: '框架 §10' },
  { n: 11, name: '迁移补齐 → 老库缺表自动补建且可继续作业', expects: '老库升级路径可用，迁移后功能正常', contract: '框架 §10' },
  { n: 12, name: '路由失效 → 围栏拒绝（E_FENCE_NO_ROUTE）', expects: '出口必须来自活跃 route；失效即拒绝出计划', contract: '框架 §3.3/§4' },
  { n: 13, name: '心跳失效 → unknown（基准 heartbeat）', expects: '长任务以最近心跳为基准；心跳失效才转 unknown', contract: 'ADR-003 D3' },
  { n: 14, name: '知识库未脱敏 → 拒绝入库（E_KB_UNSANITIZED）', expects: '未脱敏内容不得进知识库；合规内容可入库', contract: '框架 §6 开源边界' },
  { n: 15, name: '交付物边界 → 客户版无审计明细、HTML 无外部资源', expects: '受众视图不泄露内部细节；交付文件零外部依赖', contract: '框架 §5' },
  { n: 16, name: '证据落盘边界 → 索引与客户版均无明文', expects: '任何落盘产物都不含明文秘密（三处都查）', contract: 'ADR-001 D7' },
  { n: 17, name: '交付门禁 → 报告漂移必须拦下', expects: '库变了而报告未重出 → 门禁拦下（不许把过期报告发出去）', contract: 'ADR-002 D4' },
  { n: 18, name: '交付门禁 → progress 口径不因"没干活"报警', expects: '门禁只能拦"做坏了的事"，不能把"还没做"当异常', contract: '框架 §11 效率口径' },
  { n: 19, name: '人工确认边界 → 不刷绿门禁 & 自动项拒绝确认', expects: '人工确认有留痕但不改变机器判定；自动项不可被"确认"绕过', contract: '框架 §8 交付清单' },
  { n: 20, name: '归档幂等 & 时序不编造', expects: '同周归档只覆盖不新增；未知耗时不得写成 0', contract: '框架 §10/§5' },
  { n: 21, name: '门禁三层同源 → 核心与工具/脚本结论一致', expects: '同一门禁在不同入口给出同一答案（且交付口径不含出口）', contract: '框架 §2 原则' },
]);

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

  // ⑰ 交付门禁：报告漂移 → 门禁必须拦下（deliverable=false 且列出未过项）
  check('交付门禁 → 报告漂移必须拦下', () => {
    const c = ctx();
    const ex = c.broker.execute({ ...c.base, command_id: 'f-17', contract: c.contract() });
    c.broker.collect(c.eng.engagement_id, ex.task_id, c.adapter.collect(ex.task_id));
    c.broker.settle(c.eng.engagement_id, ex.task_id);

    const first = c.broker.deliver(c.eng.engagement_id, { outDir: join(c.home, 'deliver-1') });
    assert(first.gate.deliverable === true, `交付包应达标：${JSON.stringify(first.gate.blocked)}`);

    // 交付之后再写入 → 旧报告漂移
    const ex2 = c.broker.execute({ ...c.base, command_id: 'f-17b', contract: c.contract() });
    c.broker.collect(c.eng.engagement_id, ex2.task_id, c.adapter.collect(ex2.task_id));
    c.broker.settle(c.eng.engagement_id, ex2.task_id);

    const second = c.broker.deliver(c.eng.engagement_id, { outDir: join(c.home, 'deliver-1') });
    // 第二次交付：报告被重出，因此又应达标——但**旧报告文件**仍在目录里；
    // 这里验证的是"清单看的是最新一份且必须与库一致"，故加载最新报告后应达标
    assert(second.gate.deliverable === true, '重出报告后应重新达标（说明门禁会随产物更新）');

    // 构造真正的漂移：手工把库推进但不重出报告
    const store = c.broker._eng(c.eng.engagement_id).store;
    store.db.prepare(`INSERT INTO fact_members
      (adapter_instance, entity_type, source_id, revision_no, content_hash, payload, generation, active, ts)
      VALUES ('drift', 'asset', 'drift-1', 1, 'h', '{}', '1:1:1', 1, '2026-01-01T00:00:00Z')`).run();
    const checkNow = c.broker.checklist(c.eng.engagement_id, {
      reportsDir: join(c.home, 'deliver-1', 'reports'), evidenceDir: join(c.home, 'deliver-1'),
    });
    assert(checkNow.deliverable === false, '库变化后未重出报告 → 门禁必须拦下');
    assert(checkNow.blocked.some((b) => b.startsWith('report：')), JSON.stringify(checkNow.blocked));
  });

  // ⑱ 交付门禁不得误伤：还没干活不算异常（progress 口径）
  check('交付门禁 → progress 口径不因"没干活"报警', () => {
    const c = ctx();
    const progress = c.broker.checklist(c.eng.engagement_id, { profile: 'progress' });
    assert(progress.deliverable === true, `未开工不该被判不可交付：${JSON.stringify(progress.blocked)}`);
    assert(progress.gate.length <= 2, `progress 必过项应很少，实际 ${progress.gate.length}`);

    // 但"已做的东西坏了"必须拦：造一个漂移报告
    const ex = c.broker.execute({ ...c.base, command_id: 'f-18', contract: c.contract() });
    c.broker.collect(c.eng.engagement_id, ex.task_id, c.adapter.collect(ex.task_id));
    c.broker.settle(c.eng.engagement_id, ex.task_id);
    c.broker.exportReport(c.eng.engagement_id, { format: 'md' });
    const store = c.broker._eng(c.eng.engagement_id).store;
    store.db.prepare(`INSERT INTO fact_members
      (adapter_instance, entity_type, source_id, revision_no, content_hash, payload, generation, active, ts)
      VALUES ('drift2', 'asset', 'drift-2', 1, 'h', '{}', '1:1:1', 1, '2026-01-01T00:00:00Z')`).run();
    const after = c.broker.checklist(c.eng.engagement_id, { profile: 'progress' });
    assert(after.deliverable === false, '报告漂移属"已做的东西坏了"，progress 也必须拦');
  });

  // ⑲ 人工确认的边界：不得刷绿门禁；自动项拒绝"确认"
  check('人工确认边界 → 不刷绿门禁 & 自动项拒绝确认', () => {
    const c = ctx();
    const before = c.broker.checklist(c.eng.engagement_id).deliverable;
    assert(before === false, '前置：未交付时门禁应为 false');

    // 确认人工项：状态变 ✅，但门禁不受影响
    c.broker.confirmChecklistItem(c.eng.engagement_id, { itemId: 'shell', by: 'fault-matrix', note: '人工复核' });
    const after = c.broker.checklist(c.eng.engagement_id);
    assert(after.deliverable === false, '人工确认不得把门禁刷绿');
    const shellItem = after.items.find((i) => i.id === 'shell');
    assert(shellItem.status === '✅', '人工项确认后应显示 ✅');
    assert(shellItem.confirmed?.by === 'fault-matrix', '确认必须带署名');

    // 自动项拒绝确认
    let rejected = false;
    try { c.broker.confirmChecklistItem(c.eng.engagement_id, { itemId: 'report', by: 'x' }); }
    catch { rejected = true; }
    assert(rejected, '对自动项确认应当被拒绝');

    // 审计留痕存在且只有一条（被拒的那次不得落账）
    const rows = c.broker.audit(c.eng.engagement_id, { decision: 'checklist_confirm' }).rows;
    assert(rows.length === 1, `审计应恰好 1 条，实际 ${rows.length}`);
  });

  // ⑳ 归档幂等与"不编造"：同周归档不产生第二份；时序段缺时间戳不填默认值
  check('归档幂等 & 时序不编造', () => {
    const c = ctx();
    // 周报归档：同周重复执行只覆盖，不新增文件
    const a1 = c.broker.archiveWeekly({ days: 7 });
    const a2 = c.broker.archiveWeekly({ days: 7 });
    assert(a1.label === a2.label, '同一时刻归档应落同一 ISO 周');
    assert(a2.existing.length === 1, `同周不应产生第二份，实际 ${a2.existing.length}`);

    // 时序段：未结项任务入表但执行段为 null（不得填 0 或编造时间）
    const ex = c.broker.execute({ ...c.base, command_id: 'f-20', contract: c.contract() });
    void ex;
    const timeline = c.broker.timeline(c.eng.engagement_id);
    const tasks = c.broker.exportReport(c.eng.engagement_id, { format: 'json' });
    const raw = readFileSync(tasks.paths.json, 'utf8');
    const json = JSON.parse(raw);
    assert(Array.isArray(json.timing.tasks), '报告应含 timing.tasks');
    const t0 = json.timing.tasks[0];
    assert(t0 && t0.settled_at === null && t0.exec_ms === null,
      `未结项任务的执行段必须是 null，实际 settled=${t0?.settled_at} exec=${t0?.exec_ms}`);
    assert(timeline.events.some((e) => e.ts === null), '无时间戳事件应保留 ts=null（而不是补当前时间）');
  });

  // ㉑ 门禁三层同源：核心 checklist / 工具 / 外部门禁脚本 结论必须一致
  check('门禁三层同源 → 核心与工具/脚本结论一致', async () => {
    const c = ctx();
    const core = c.broker.checklist(c.eng.engagement_id);
    // 工具层：经插件服务（第二个宿主实例，读同一家目录）——验证结论不随进程/宿主变化
    const { createWarroomService } = await import('../../../warroom-plugin/src/service.js');
    const svc = createWarroomService({ home: c.home, adapter: new FakeAdapter() });
    const viaService = svc.broker.checklist(c.eng.engagement_id);
    assert(core.deliverable === viaService.deliverable,
      `核心(${core.deliverable}) 与插件服务(${viaService.deliverable}) 结论不一致`);
    assert(core.blocked.length === viaService.blocked.length, '未过项数量应一致');

    // 明确口径：交付门禁不要求活跃出口（避免有人日后"顺手加进去"造成误判）
    const required = new Set(core.required);
    assert(!required.has('egress'), '交付口径不应包含"活跃出口"（交付是产出物的事）');
  });

  const failed = checks.filter((x) => !x.ok);
  return { total: checks.length, passed: checks.length - failed.length, failed, checks: [...checks] };
}
