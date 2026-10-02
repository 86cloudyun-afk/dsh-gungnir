// 影响面摘要（客户视角）：把事实库翻译成"业务上意味着什么"。
// 铁律：只对**账本里有证据**的东西下结论；推不出来的写"未评估"，不替客户猜。
// 粗分类规则：**先判高，再判中**；规则收窄，避免"版本泄露"被抬成高危
const SEVERITY_HINT = [
  { match: /shell|rce|命令执行|命令注入|反序列/i, level: '高', why: '可导致服务器被直接控制' },
  { match: /凭据泄露|credential|弱口令|默认口令|明文口令/i, level: '高', why: '可导致身份被冒用并横向移动' },
  { match: /sqli|sql 注入|越权|未授权|unauth|idor/i, level: '高', why: '可导致数据被读取或篡改' },
  { match: /ssrf|traversal|lfi|文件上传|上传/i, level: '中', why: '可导致边界被绕过或文件被读写' },
  { match: /信息泄露|版本泄露|错误回显|banner|堆栈/i, level: '中', why: '为后续攻击提供入口线索' },
];

/**
 * @param {Array} facts 有效事实（已脱敏；payload 已解析为对象）
 * @param {object} shellState { highest_proof, current_validity, last_verified_at }
 */
export function buildImpact(facts = [], shellState = null) {
  const assets = new Set();
  const domains = new Set();
  for (const f of facts) {
    if (['asset', 'domain', 'session', 'shell'].includes(f.entity_type)) assets.add(f.source_id);
    if (f.entity_type === 'domain') domains.add(f.source_id);
  }
  const vulns = facts.filter((f) => f.entity_type === 'vuln');
  const creds = facts.filter((f) => f.entity_type === 'credential');
  const chains = facts.filter((f) => f.entity_type === 'chain');
  const shells = facts.filter((f) => f.entity_type === 'shell');

  const reasons = [];
  const pushReason = (level, text) => {
    if (!reasons.some((r) => r.text === text)) reasons.push({ level, text });
  };
  for (const v of [...vulns, ...chains, ...shells]) {
    const hay = `${v.source_id} ${JSON.stringify(v.payload ?? {})}`;
    const hit = SEVERITY_HINT.find((s) => s.match.test(hay));
    pushReason(hit ? hit.level : '中', hit ? `${v.source_id}：${hit.why}` : `${v.source_id}：需结合资产重要性评估`);
  }
  const hasControl = (shellState?.highest_proof ?? null) !== null || shells.length > 0;
  if (hasControl) pushReason('高', '已取得控制面证明（见 shell 状态与会话记录）');

  const level = reasons.some((r) => r.level === '高') ? '高'
    : reasons.some((r) => r.level === '中') ? '中'
      : (reasons.length > 0 ? '低' : '未评估');

  return {
    scope: {
      assets: assets.size,
      domains: domains.size,
      note: '资产/域名按事实库中的实体计数（同一 source_id 只算一次）',
    },
    findings: { vulns: vulns.length, credentials: creds.length, chains: chains.length, shells: shells.length },
    control: shellState
      ? { highest_proof: shellState.highest_proof, current_validity: shellState.current_validity, last_verified_at: shellState.last_verified_at }
      : { highest_proof: null, current_validity: 'unknown', last_verified_at: null },
    severity: { level, reasons },
    caveats: [
      '本摘要只依据已落库证据；未覆盖的资产/系统不在其中（不等于安全）',
      '严重度是**技术影响**的粗分类，未代入业务重要性权重（需结合资产台账判断）',
      shellState?.current_validity === 'confirmed_lost' ? '控制面已确认失效（复验后），当前不可控' : null,
    ].filter(Boolean),
  };
}

/** 渲染为 markdown 段（客户版报告用）。 */
export function renderImpact(impact) {
  const lines = [];
  lines.push(`- **影响面等级：${impact.severity.level}**（依据：` + (impact.severity.reasons.length
    ? impact.severity.reasons.map((r) => r.text).join('；') : '尚无足够证据') + '）');
  lines.push(`- 涉及资产：**${impact.scope.assets}** 个（域名 ${impact.scope.domains} 个）；`
    + `弱点 ${impact.findings.vulns} 条 · 凭据 ${impact.findings.credentials} 条 · `
    + `可利用链路 ${impact.findings.chains} 条 · 控制面事实 ${impact.findings.shells} 条`);
  lines.push(`- 控制面：最高证明 \`${impact.control.highest_proof ?? '—'}\` · `
    + `当前有效性 \`${impact.control.current_validity ?? 'unknown'}\``
    + `${impact.control.last_verified_at ? `（最后复验 ${impact.control.last_verified_at}）` : '（尚未复验）'}`);
  lines.push('- 说明：');
  for (const c of impact.caveats) lines.push(`  - ${c}`);
  return lines.join('\n');
}
