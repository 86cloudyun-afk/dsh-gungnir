#!/usr/bin/env node
// 工具文档生成与同步校验：docs/TOOLS.md 必须与代码（TOOLS + 预设允许清单）一致。
// 用法：node scripts/gen-docs.mjs [--write] [--check]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../packages/warroom-tools/src/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(repoRoot, 'docs', 'TOOLS.md');
const write = process.argv.includes('--write');
const check = process.argv.includes('--check');

const preset = JSON.parse(readFileSync(join(repoRoot, 'presets', 'warroom.preset.json'), 'utf8'));
const allow = new Set(preset.toolPolicy.allow);
const roles = preset.roles ?? [];

const typeOf = (s) => {
  if (!s) return '-';
  if (s.type === 'object') {
    const req = new Set(s.required ?? []);
    const props = Object.entries(s.properties ?? {})
      .map(([k, v]) => `${k}${req.has(k) ? '*' : ''}:${Array.isArray(v.enum) ? v.enum.join('|') : v.type ?? '?'}`)
      .join(', ');
    return `{ ${props} }`;
  }
  return s.type ?? '-';
};

const lines = [];
lines.push('# 工具清单（自动生成，勿手改）');
lines.push('');
lines.push(`> 由 \`node scripts/gen-docs.mjs --write\` 生成；CI 用 \`--check\` 校验同步（防文档漂移）。`);
lines.push(`> 工具数：**${TOOLS.length}**；全部在预设允许清单中：**${TOOLS.every((t) => allow.has(t.name)) ? '是' : '否'}**；角色：${roles.join(' / ')}`);
lines.push('');
lines.push('| 工具 | 说明 | 参数（* = 必填） | 在允许清单 |');
lines.push('|---|---|---|---|');
for (const t of TOOLS) {
  lines.push(`| \`${t.name}\` | ${t.description} | \`${typeOf(t.input_schema)}\` | ${allow.has(t.name) ? '✅' : '❌'} |`);
}
lines.push('');
lines.push('## 约定');
lines.push('');
lines.push('- 副作用只能经 `warroom_execute`（服务端 broker 校验四元组）；其余工具为查询/登记。');
lines.push('- 新增工具必须：进 `presets/warroom.preset.json` 的 allow（否则预设闸失败），并重跑本生成器。');
lines.push('- 秘密相关工具只到 `secret_ref` 粒度，解析（resolve）只存在于 host 侧，无对应工具。');
lines.push('');
const content = lines.join('\n');

// 机器可读导出：供外部集成（DSH 挂载、MCP 桥、审计工具）消费
const schemaTarget = join(repoRoot, 'docs', 'tools.schema.json');
const schemaExport = {
  schema: 'gungnir-tools/1',
  generated_from: 'packages/warroom-tools/src/index.js',
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    in_allowlist: allow.has(t.name),
  })),
  preset: { id: preset.id, roles: preset.roles, allowlist_mode: preset.toolPolicy.mode },
};
const schemaContent = JSON.stringify(schemaExport, null, 2) + '\n';

// ── 看板契约导出：由**真实样本**推导字段路径（外部看板据此对齐，字段漂移即 CI 失败）──
const flattenKeys = (obj, prefix = '', out = new Set(), depth = 0) => {
  if (depth > 4 || obj === null || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    if (obj.length > 0) flattenKeys(obj[0], `${prefix}[]`, out, depth + 1);
    else out.add(`${prefix}[]`);
    return out;
  }
  for (const [k, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.add(path);
    if (val !== null && typeof val === 'object') flattenKeys(val, path, out, depth + 1);
  }
  return out;
};

async function buildDashboardContract() {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { Broker } = await import('../packages/warroom-core/src/broker.js');
  const { FakeAdapter } = await import('../packages/warroom-core/src/adapters/fake.js');
  const home = mkdtempSync(join(tmpdir(), 'wr-dash-'));
  // neverFinish：让样本里**留一个在飞任务**，否则数组类字段（tasks.in_flight[]）推导不出嵌套字段
  const adapter = new FakeAdapter({ faults: { neverFinish: true } });
  const broker = new Broker({ home, adapter });
  const eng = broker.createEngagement({ user_message_id: 'dash', targets: ['10.0.0.0/24'], overrides: { rhythm: 'open' } });
  const ex = broker.execute({
    command_id: 'dash-1', engagement_id: eng.engagement_id, auth_version: 1, action_class: 'active',
    contract: {
      targets: ['10.0.0.5'], action_class: 'active', resources: [], wire_cost: 1,
      fake_members: [
        { entity_type: 'asset', source_id: 'dash-asset', revision_no: 1, content_hash: 'h1', payload: { note: 'x' } },
        { entity_type: 'vuln', source_id: 'CVE-DASH-1', revision_no: 1, content_hash: 'h2', payload: { note: 'RCE 命令执行' } },
      ],
    },
  });
  broker.collect(eng.engagement_id, ex.task_id, adapter.collect(ex.task_id));
  broker.heartbeat(eng.engagement_id, ex.task_id, { note: '合同样本' });   // 心跳字段也进契约
  // 再派一个任务并留在飞（不结项）；报告仍导出（跑过的那个已在账本里）
  broker.execute({
    command_id: 'dash-2', engagement_id: eng.engagement_id, auth_version: 1, action_class: 'active',
    contract: {
      targets: ['10.0.0.6'], action_class: 'active', resources: [], wire_cost: 0,
      fake_members: [{ entity_type: 'asset', source_id: 'dash-asset-2', revision_no: 1, content_hash: 'h3', payload: {} }],
    },
  });
  const report = broker.exportReport(eng.engagement_id, { format: 'json' });
  const { readFileSync } = await import('node:fs');
  return {
    schema: 'gungnir-dashboards/1',
    note: '外部看板消费的字段契约：由真实样本生成，字段漂移会让 CI 的 docs 闸失败',
    views: {
      watch: [...flattenKeys(broker.watch(eng.engagement_id))].sort(),
      fleet: [...flattenKeys(broker.fleetWatch())].sort(),
      weekly: [...flattenKeys(broker.weekly({ days: 7 }))].sort(),
      rate: [...flattenKeys(broker.rateView(eng.engagement_id))].sort(),
      checklist: [...flattenKeys(broker.checklist(eng.engagement_id))].sort(),
      timeline: [...flattenKeys(broker.timeline(eng.engagement_id))].sort(),
      report: [...flattenKeys(JSON.parse(readFileSync(report.paths.json, 'utf8')))].sort(),
    },
  };
}

const dashboardTarget = join(repoRoot, 'docs', 'dashboards.schema.json');
const dashboardContent = JSON.stringify(await buildDashboardContract(), null, 2) + '\n';


if (write) {
  writeFileSync(target, content, 'utf8');
  writeFileSync(schemaTarget, schemaContent, 'utf8');
  writeFileSync(dashboardTarget, dashboardContent, 'utf8');
  console.log(`[✓] 已写入 docs/TOOLS.md、docs/tools.schema.json 与 docs/dashboards.schema.json（${TOOLS.length} 个工具）`);
} else if (check) {
  const problems = [];
  if (!existsSync(target)) problems.push('docs/TOOLS.md 不存在');
  else if (readFileSync(target, 'utf8') !== content) problems.push('docs/TOOLS.md 与代码不一致');
  if (!existsSync(schemaTarget)) problems.push('docs/tools.schema.json 不存在');
  else if (readFileSync(schemaTarget, 'utf8') !== schemaContent) problems.push('docs/tools.schema.json 与代码不一致');
  if (!existsSync(dashboardTarget)) problems.push('docs/dashboards.schema.json 不存在');
  else if (readFileSync(dashboardTarget, 'utf8') !== dashboardContent) {
    problems.push('docs/dashboards.schema.json 与看板视图不一致（字段漂移）');
  }
  if (problems.length) {
    console.error(`[✗] ${problems.join('；')}——运行 \`node scripts/gen-docs.mjs --write\` 后提交`);
    process.exit(1);
  }
  console.log(`[✓] 工具文档与 schema 导出同步（${TOOLS.length} 个工具）`);
} else {
  process.stdout.write(content);
}
