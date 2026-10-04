// 攻击路径拓扑（报告用）：把事实库拼成"资产 → 弱点 → 链路 → 控制面"的图。
// 铁律：**只有 payload 里给出引用时才画边**；没有引用就只给节点 + 明确说明，
// 不靠猜（猜测出来的边会让客户和蓝队误判）。
const NODE_KIND = { asset: 'asset', domain: 'domain', vuln: 'vuln', credential: 'credential',
  session: 'session', chain: 'chain', shell: 'shell', persistence: 'persistence' };

function labelOf(row, redactLabel) {
  const src = row.source_id ?? row.id ?? 'unknown';
  const kind = NODE_KIND[row.entity_type] ?? 'other';
  const label = String(redactLabel(String(src)));
  const short = label.length > 40 ? `${label.slice(0, 37)}…` : label;
  return { id: `${kind}:${src}`, label: short, kind };
}

function parsePayload(row) {
  try { return JSON.parse(row.payload ?? '{}'); } catch { return {}; }
}

/**
 * @param {Array} facts 有效事实行
 * @param {object} opts redactLabel 在完整 label 上脱敏，不改内部身份/连接键
 * @returns {{nodes:Array<{id,label,kind}>, edges:Array<{from,to,via}>, derived_from:string, unexplained:number}}
 */
export function buildTopology(facts = [], { redactLabel = (s) => s } = {}) {
  // 身份/引用仍按原始 source_id 连接；完整展示 label 先脱敏再截断。
  const nodes = facts.map((row) => labelOf(row, redactLabel));
  const idBySource = new Map();
  for (let i = 0; i < facts.length; i += 1) {
    const key = facts[i].source_id;
    if (key && !idBySource.has(key)) idBySource.set(key, nodes[i].id);
  }
  const edges = [];
  let unexplained = 0;
  const hasEdge = (from, to) => edges.some((e) => e.from === from && e.to === to);

  /**
   * @param {'explicit'|'inferred'} kind 显式引用优先：已存在同向边时不覆盖标签。
   * @returns {'added'|'exists'|'invalid'} —— 'exists' 也算"该事实已有连接"（用于 unexplained 统计）
   */
  const addEdge = (fromKey, toKey, via, kind = 'explicit') => {
    const from = idBySource.get(fromKey);
    const to = idBySource.get(toKey);
    if (!from || !to || from === to) return 'invalid';
    if (hasEdge(from, to)) return 'exists';
    edges.push({ from, to, via, kind });
    return 'added';
  };

  const linkedRows = new Set();

  // 第一遍：**显式**引用（链路步骤/路径/取得方式）——它们才是"攻击路径"的权威描述
  for (const row of facts) {
    const payload = parsePayload(row);
    const self = row.source_id;
    for (const step of payload.steps ?? []) {
      if (step?.from && step?.to && addEdge(step.from, step.to, step.via ?? 'chain-step') !== 'invalid') linkedRows.add(self);
    }
    const path = payload.path ?? payload.chain ?? null;
    if (Array.isArray(path) && path.length >= 2) {
      for (let k = 0; k + 1 < path.length; k += 1) {
        if (addEdge(String(path[k]), String(path[k + 1]), 'path') !== 'invalid') linkedRows.add(self);
      }
    }
    if (typeof payload.achieved_via === 'string' && addEdge(payload.achieved_via, self, 'achieved_via') !== 'invalid') {
      linkedRows.add(self);
    }
  }

  // 第二遍：**推断**引用（asset/target/host/… 指向的 source_id），只补显式边没有的连接
  for (const row of facts) {
    const payload = parsePayload(row);
    const self = row.source_id;
    for (const field of ['asset', 'target', 'host', 'via', 'source_ref', 'unlocks']) {
      const ref = payload[field];
      if (typeof ref !== 'string') continue;
      // 'exists' 也表示"这条事实已有连接"（可能由别的行的显式步骤建立）
      if (addEdge(ref, self, field, 'inferred') !== 'invalid') linkedRows.add(self);
    }
  }

  for (const row of facts) {
    if (!linkedRows.has(row.source_id)
      && (row.entity_type === 'chain' || row.entity_type === 'shell' || row.entity_type === 'vuln')) {
      unexplained += 1;   // 有"本应连起来"的事实却没有引用 → 如实计数
    }
  }

  return {
    nodes,
    edges,
    derived_from: 'fact_members.payload（steps|path|asset|target|host|via|source_ref|unlocks|achieved_via）',
    unexplained,
  };
}

/** 渲染 mermaid（flowchart LR）。节点多时只画有边的子图 + 统计行。 */
export function toMermaid(topology, { maxNodes = 60 } = {}) {
  const connected = new Set(topology.edges.flatMap((e) => [e.from, e.to]));
  const keep = topology.nodes.filter((n) => connected.has(n.id)).slice(0, maxNodes);
  const keepIds = new Set(keep.map((n) => n.id));
  const lines = ['```mermaid', 'flowchart LR'];
  const safe = (s) => String(s).replace(/[[\]{}()"|]/g, ' ');
  for (const n of keep) lines.push(`  ${hashId(n.id)}["${safe(n.label)}"]`);
  for (const e of topology.edges) {
    if (!keepIds.has(e.from) || !keepIds.has(e.to)) continue;
    const label = e.kind === 'inferred' ? `${safe(e.via)}（推断）` : safe(e.via);
    lines.push(`  ${hashId(e.from)} -->|${label}| ${hashId(e.to)}`);
  }
  lines.push('```');
  return lines.join('\n');
}

const hashId = (id) => `n${Math.abs([...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7))}`;

const KIND_GROUP = {
  asset: '资产', domain: '资产', vuln: '弱点', credential: '凭据',
  chain: '攻击路径', session: '控制面', shell: '控制面', persistence: '控制面',
};
const CONTROL_KINDS = new Set(['shell', 'session', 'persistence']);

/**
 * 渲染带分组与图例的 mermaid：
 *   · 按类型分子图（subgraph）——一眼看出"资产/弱点/路径/控制面"各有哪些
 *   · **通往控制面的边加粗高亮**（`==>`）——那就是"链到 shell"的关键跳
 *   · 无引用的事实不会出现在图上（图只画有证据的连接）
 */
export function toMermaidGrouped(topology, { maxNodes = 60 } = {}) {
  const connected = new Set(topology.edges.flatMap((e) => [e.from, e.to]));
  const keep = topology.nodes.filter((n) => connected.has(n.id)).slice(0, maxNodes);
  const keepIds = new Set(keep.map((n) => n.id));
  const nodeById = new Map(keep.map((n) => [n.id, n]));
  const safe = (s) => String(s).replace(/[[\]{}()"|]/g, ' ');

  const groups = new Map();
  for (const n of keep) {
    const g = KIND_GROUP[n.kind] ?? '其它';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(n);
  }

  const lines = ['```mermaid', 'flowchart LR'];
  for (const [group, nodes] of groups) {
    lines.push(`  subgraph ${group}`);
    for (const n of nodes) lines.push(`    ${hashId(n.id)}["${safe(n.label)}"]`);
    lines.push('  end');
  }
  const critical = [];
  for (const e of topology.edges) {
    if (!keepIds.has(e.from) || !keepIds.has(e.to)) continue;
    const toKind = nodeById.get(e.to)?.kind;
    const isCritical = CONTROL_KINDS.has(toKind);      // 通向控制面 = 关键跳
    const label = e.kind === 'inferred' ? `${safe(e.via)}（推断）` : safe(e.via);
    lines.push(`  ${hashId(e.from)} ${isCritical ? '==>' : '-->'}|${label}| ${hashId(e.to)}`);
    if (isCritical) critical.push({ from: nodeById.get(e.from)?.label, to: nodeById.get(e.to)?.label, via: e.via });
  }
  lines.push('```');
  return { mermaid: lines.join('\n'), critical, groups: [...groups.keys()] };
}
