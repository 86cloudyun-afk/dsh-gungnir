// IOC / 清理清单自动聚合（v0.2 提前落地）：结构化、可去重、带置信度与证据引用。
// 原则：IOC 附录与客户报告同源（同一份证据两个视图）；自动项与人工项分开标注。
import { createHash } from 'node:crypto';

const CONFIDENCE = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

const KIND = {
  CREDENTIAL: 'credential-ref',
  SESSION: 'session',
  CHAIN_STEP: 'chain-step',
  TUNNEL: 'tunnel',
  UNFINISHED: 'unfinished-task',
  QUARANTINED: 'quarantined-resource',
  ARTIFACT: 'artifact',
};

const dedupeKey = (kind, ref) => `${kind}::${ref}`;

/**
 * @param {{store:object, globalDb:object, engagementId:string}} p
 * @returns {{items:Array<object>, summary:object}}
 */
export function aggregateIoc({ store, globalDb, engagementId }) {
  const items = [];
  const seen = new Set();
  const add = (item) => {
    const key = dedupeKey(item.kind, item.ref);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ manual_confirm: true, ...item });
  };

  // 事实侧（凭据/会话/链步）——证据引用齐全，置信度高
  const members = store.db.prepare('SELECT * FROM fact_members WHERE active = 1').all();
  for (const m of members) {
    const payload = (() => { try { return JSON.parse(m.payload ?? '{}'); } catch { return {}; } })();
    const evidence = `fact#${m.id}`;
    if (m.entity_type === 'credential') {
      add({ kind: KIND.CREDENTIAL, ref: m.source_id, source: 'fact', evidence_ref: evidence,
        confidence: CONFIDENCE.HIGH, note: '凭据引用（明文在加密库，不进报告）；收口时确认是否需轮换' });
    } else if (m.entity_type === 'session') {
      add({ kind: KIND.SESSION, ref: m.source_id, source: 'fact', evidence_ref: evidence,
        confidence: CONFIDENCE.HIGH, note: `会话/立足点（${payload.host ?? '目标未记'}）：确认已拆除` });
    } else if (m.entity_type === 'chain') {
      add({ kind: KIND.CHAIN_STEP, ref: m.source_id, source: 'fact', evidence_ref: evidence,
        confidence: CONFIDENCE.MEDIUM, note: '攻击链步骤：核对是否留下工具/文件/账号' });
    }
  }

  // 运行侧（隧道/未完成任务/隔离资源）
  for (const r of store.db.prepare('SELECT * FROM jump_routes').all()) {
    add({ kind: KIND.TUNNEL, ref: r.route_id, source: 'route', evidence_ref: `jump_routes#${r.route_id}`,
      confidence: CONFIDENCE.HIGH, manual_confirm: false,
      note: `隧道 ${r.socks}（跳板 ${r.jumphost_id}）→ 收口执行 \`jumphost_release\`` });
  }
  for (const c of globalDb.prepare('SELECT command_id, task_id, state FROM command_queue WHERE engagement_id = ?').all(engagementId)) {
    if (['unresolved', 'unknown', 'failed'].includes(c.state)) {
      add({ kind: KIND.UNFINISHED, ref: c.task_id, source: 'command', evidence_ref: `command#${c.command_id}`,
        confidence: c.state === 'unresolved' ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM,
        note: `任务终态 ${c.state}：先 reconcile 定论，再确认无资源残留` });
    }
  }
  for (const o of globalDb.prepare("SELECT op_id, ref_id, detail FROM op_log WHERE state = 'quarantined'").all()) {
    add({ kind: KIND.QUARANTINED, ref: o.ref_id ?? o.op_id, source: 'op_log', evidence_ref: `op_log#${o.op_id}`,
      confidence: CONFIDENCE.HIGH, note: `隔离态资源：${o.detail ?? '需人工处置'}` });
  }

  const byKind = items.reduce((acc, i) => { acc[i.kind] = (acc[i.kind] ?? 0) + 1; return acc; }, {});
  const digest = createHash('sha256').update(JSON.stringify(items.map((i) => [i.kind, i.ref, i.confidence]))).digest('hex');
  return {
    items,
    summary: {
      total: items.length,
      by_kind: byKind,
      manual_confirm_required: items.filter((i) => i.manual_confirm).length,
      digest,
    },
  };
}

export { KIND as IOC_KIND, CONFIDENCE as IOC_CONFIDENCE };
