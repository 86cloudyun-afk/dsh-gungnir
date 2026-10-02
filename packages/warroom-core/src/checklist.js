// 交付清单（验收 12 项的操作化）：自动项按真实状态判定，人工项留空勾选框。
// 原则：自动项**只依据账本与文件**判定；判定不了的绝不打勾（写"人工确认"并说明为什么）。
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyReportAgainstStore } from './report.js';

const OK = '✅';
const PENDING = '⬜';   // 未完成标记（常量名刻意避开代码待办约定词，免得自审闸误判）
const MANUAL = '☐';

/**
 * @param {{broker:object, engagementId:string}} p
 * @returns {{items:Array<{id,title,status,detail,manual?:boolean}>, done:number, total:number, manual:number}}
 */
/**
 * @param {{broker:object, engagementId:string, profile?:'delivery'|'progress'}} p
 *   profile=delivery：交付口径——"尚未导出报告/证据未落盘/无备份"等**必过项**；
 *   profile=progress：进度口径——只把"明显不该发生"的失败项视为必过（用于日常巡检门禁）。
 *   口径写进返回值 `required`，命令行的 --strict 按它判定退出码。
 */
export function buildChecklist({ broker, engagementId, profile = 'delivery', reportsDir = null, evidenceDir = null }) {
  const store = broker._eng(engagementId).store;
  const row = store.db.prepare('SELECT * FROM engagements WHERE id = ?').get(engagementId);
  const items = [];
  const add = (id, title, ok, detail, manual = false) =>
    items.push({ id, title, status: manual ? MANUAL : (ok ? OK : PENDING), detail, manual });

  // 1 授权对象冻结
  add('auth', '授权对象已冻结（auth_version / auth_hash）',
    !!row?.auth_version && !!row?.auth_hash,
    row ? `auth v${row.auth_version} · 目标 ${row.target_scope}` : '战役不存在');

  // 2 出口与验证
  const routes = (() => { try { return store.db.prepare('SELECT * FROM jump_routes ORDER BY ts').all(); } catch { return []; } })();
  const active = routes.filter((r) => r.state === 'active');
  const released = routes.filter((r) => r.state === 'released');
  const egress = broker.egressStatus(engagementId);
  add('egress', '活跃出口存在且出口验证有效',
    active.length > 0 && egress.valid,
    `活跃 route ${active.length} · 出口验证 ${egress.valid ? '有效' : '无效/未做'}`);

  // 3 节奏与预算
  const rate = broker.rateView(engagementId);
  add('rhythm', '节奏档与 wire 预算未触顶',
    !rate.wire.exhausted,
    `档位 ${rate.rhythm} · wire ${rate.wire.used}${rate.wire.cap > 0 ? `/${rate.wire.cap}` : ''}`
    + `${rate.spray.locked > 0 ? ` · 喷洒锁定 ${rate.spray.locked}（需说明）` : ''}`);

  // 4 事实水位与证据摘要
  const snap = store.exportSnapshot();
  add('watermark', '事实水位与证据摘要固定',
    snap.seq > 0,
    `seq ${snap.seq} · 有效事实 ${snap.rows.length} · snapshot ${String(snap.snapshot_id).slice(0, 12)}…`);

  // 5 攻击路径（拓扑有边）
  const facts = snap.rows.map((r) => {
    let payload = {};
    try { payload = JSON.parse(r.payload ?? '{}'); } catch { payload = {}; }
    return { ...r, payload };
  });
  const chainFacts = facts.filter((f) => ['chain', 'shell'].includes(f.entity_type));
  add('path', '攻击路径已合成（链路/控制面事实）',
    chainFacts.length > 0,
    `链路/控制面事实 ${chainFacts.length} 条`);

  // 6 控制面状态
  const shell = store.shellState();
  add('shell', '控制面状态已登记（历史证明 + 当前有效性分离）',
    !!shell?.highest_proof,
    shell ? `最高证明 ${shell.highest_proof} · 当前有效性 ${shell.current_validity}` : '未登记',
    true);   // 当前有效性必须人工复核（不能因为历史拿过就打勾）

  // 7 报告可复现（目录可覆盖：交付包落在自定义位置时，清单必须看同一个位置）
  const reportsRoot = reportsDir ?? join(broker.home, 'engagements', engagementId, 'reports');
  const reports = existsSync(reportsRoot)
    ? readdirSync(reportsRoot).filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, m: statSync(join(reportsRoot, f)).mtimeMs })).sort((a, b) => b.m - a.m)
    : [];
  let reproducible = false;
  if (reports.length > 0) {
    try {
      reproducible = verifyReportAgainstStore(readFileSync(join(reportsRoot, reports[0].f), 'utf8'), store).reproducible;
    } catch { reproducible = false; }
  }
  add('report', '报告已导出且可复现（水位/摘要一致）',
    reports.length > 0 && reproducible,
    reports.length === 0 ? '尚未导出报告' : `${reports[0].f} · ${reproducible ? '与库一致' : '已漂移，需重出'}`);

  // 8 证据落盘
  const evidenceRoot = evidenceDir ?? join(broker.home, 'engagements', engagementId, 'evidence');
  const indexFiles = existsSync(evidenceRoot)
    ? readdirSync(evidenceRoot).filter((f) => f === 'EVIDENCE_INDEX.md').length : 0;
  add('evidence', '证据目录与三段式索引已落盘',
    indexFiles > 0,
    indexFiles > 0 ? `EVIDENCE_INDEX.md 存在（${existsSync(join(evidenceRoot, 'client')) ? '含客户版/蓝队版视图' : '未含受众视图'}）` : '尚未落盘');

  // 9 审计可追溯
  const gates = store.db.prepare('SELECT COUNT(*) AS n FROM gate_log').get().n;
  add('audit', '门闸判定全量留痕（可导出）', gates > 0, `gate_log ${gates} 条`);

  // 10 备份新鲜度
  const backupsDir = join(broker.home, 'backups');
  const backups = existsSync(backupsDir)
    ? readdirSync(backupsDir).map((n) => ({ n, m: statSync(join(backupsDir, n)).mtimeMs })).sort((a, b) => b.m - a.m)
    : [];
  const fresh = backups.length > 0 && (Date.now() - backups[0].m) / 86400000 <= 7;
  add('backup', '近 7 天内有备份', fresh,
    backups.length === 0 ? '从未备份' : `${backups[0].n}（${((Date.now() - backups[0].m) / 86400000).toFixed(1)} 天前）`);

  // 11 跳板收口
  add('cleanup', '跳板/隧道已收口（或明确保留）',
    active.length === 0,
    active.length === 0 ? `已收口 ${released.length} 条` : `仍有 ${active.length} 条活跃（收口前需说明理由）`);

  // 12 IOC 附录人工确认（半自动：机器给清单，人去核）
  const ioc = (() => { try { return store.db.prepare("SELECT COUNT(*) AS n FROM gate_log WHERE decision = 'ioc_draft'").get().n; } catch { return 0; } })();
  add('ioc', 'IOC 附录逐条人工确认', false,
    `附录为半自动初稿（草稿事件 ${ioc} 条）：需人工确认后才可用于蓝队排查`, true);

  // 人工项的确认记录（谁/何时/结论）——机器不替人打勾，但**确认本身要留痕**
  const confirmations = (() => {
    try {
      return store.db.prepare("SELECT ts, detail FROM gate_log WHERE decision = 'checklist_confirm' ORDER BY id").all()
        .map((r) => {
          let d = {};
          try { d = JSON.parse(r.detail ?? '{}'); } catch { d = {}; }
          return { ts: r.ts, ...d };
        });
    } catch { return []; }
  })();
  for (const item of items.filter((i) => i.manual)) {
    const hit = [...confirmations].reverse().find((c) => c.item_id === item.id);
    if (hit) {
      item.status = OK;                       // 人确认后仍未"机器自动通过"，但状态反映事实
      item.confirmed = { at: hit.ts, by: hit.by ?? '（未署名）', note: hit.note ?? '' };
      item.detail = `${item.detail}｜已确认：${hit.by ?? '（未署名）'} @ ${hit.ts}${hit.note ? `（${hit.note}）` : ''}`;
    } else {
      item.pending_confirmation = true;
    }
  }

  const done = items.filter((i) => i.status === OK).length;
  const manual = items.filter((i) => i.manual).length;

  // 必过项（gate）：
  //   delivery —— 对外交付面必须齐全（授权/水位/报告可复现/证据/审计/备份）
  //   progress —— **只盯"已做的东西没有坏"**：没干活不算异常（水位可空、可无报告/证据/备份），
  //              但一旦存在就必须是好的（报告不得漂移、备份不得过期）
  const deliveryRequired = ['auth', 'watermark', 'report', 'evidence', 'audit', 'backup'];
  const progressRequired = ['auth'];
  if (snap.rows.length > 0) progressRequired.push('watermark');
  if (reports.length > 0 && !reproducible) progressRequired.push('report');
  if (indexFiles > 0) progressRequired.push('evidence');
  if (backups.length > 0 && !fresh) progressRequired.push('backup');
  const required = profile === 'delivery' ? deliveryRequired : progressRequired;
  const gate = items
    .filter((i) => required.includes(i.id))
    .map((i) => ({ id: i.id, title: i.title, passed: i.status === OK, detail: i.detail }));
  const blocked = gate.filter((g) => !g.passed);

  return {
    engagement_id: engagementId, items, done, total: items.length - manual, manual,
    profile, required, gate, blocked: blocked.map((b) => `${b.id}：${b.detail}`),
    deliverable: blocked.length === 0,
  };
}

/** 渲染成可勾选 markdown（交付附件）。 */
/**
 * 记录一次人工确认（谁/何时/结论）——只写审计，不改任何自动判定。
 * @param {{store:object, itemId:string, by:string, note:string, now?:string}} p
 */
export function recordConfirmation({ store, itemId, by = null, note = '', now = null }) {
  const allowed = ['shell', 'ioc'];
  if (!allowed.includes(itemId)) {
    throw new Error(`人工确认只适用于人工项（${allowed.join('/')}），收到：${itemId}`);
  }
  const ts = now ?? new Date().toISOString();
  store.appendGateLog({
    decision: 'checklist_confirm',
    detail: JSON.stringify({ item_id: itemId, by, note }),
    recovered_at: ts,
  });
  return { item_id: itemId, by, note, at: ts };
}

export function renderChecklist(c) {
  const lines = [];
  lines.push(`# 交付清单 · ${c.engagement_id}`);
  lines.push('');
  lines.push(`- 自动判定：**${c.done}/${c.total}** 项通过`);
  lines.push(`- 人工确认：**${c.manual}** 项（需人核，机器不打勾）`);
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push('');
  for (const item of c.items) {
    const tag = item.manual ? '（人工）' : '';
    lines.push(`- ${item.status} **${item.title}**${tag} — ${item.detail}`);
  }
  const pending = c.items.filter((i) => i.manual && i.pending_confirmation);
  if (pending.length > 0) {
    lines.push('');
    lines.push('**待人工确认**：');
    for (const p of pending) lines.push(`- \`${p.id}\` ${p.title}`);
    lines.push('');
    lines.push('确认方式：`warroom checklist --engagement <id> --confirm <id> --by <你> --note "<结论>"`');
  }
  lines.push('');
  lines.push('');
  lines.push(`**门禁口径（${c.profile}）**：必过项 ${c.gate.length} 项，`
    + (c.deliverable ? '全部通过 ✅' : `**${c.blocked.length} 项未通过** ⬜`));
  for (const b of c.blocked) lines.push(`- 未过：${b}`);
  lines.push('');
  lines.push('> 判定原则：自动项只依据账本与文件；判定不了的写"人工确认"，绝不打勾充数。');
  return lines.join('\n');
}
