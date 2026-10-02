#!/usr/bin/env node
// 规模冒烟：事实入库 / 快照 / 报告 / 复现校验的耗时与正确性门槛。
// 用法：node scripts/bench.mjs [--n 1000] [--json]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';
import { backupHome } from '../packages/warroom-core/src/maintenance.js';

const { values: v } = parseArgs({ args: process.argv.slice(2), options: { n: { type: 'string', default: '1000' }, json: { type: 'boolean', default: false } } });
const N = Number(v.n);
const THRESHOLDS = {
  ingest_ms: 3000, snapshot_ms: 1000, report_ms: 3000, verify_ms: 1000,
  audit_export_ms: 1500, matrix_ms: 1500, json_report_ms: 3000,
  evidence_export_ms: 4000, backup_ms: 6000,
};

const home = mkdtempSync(join(tmpdir(), 'wr-bench-'));
const broker = new Broker({ home, adapter: new FakeAdapter() });
const eng = broker.createEngagement({ user_message_id: 'bench', targets: ['10.0.0.0/24'] });
const store = broker._eng(eng.engagement_id).store;

const members = Array.from({ length: N }, (_, i) => ({
  entity_type: i % 5 === 0 ? 'credential' : i % 7 === 0 ? 'session' : 'asset',
  source_id: `bench-${i}`, revision_no: 1, content_hash: `h-${i}`, payload: { ip: `10.0.0.${i % 255}`, idx: i },
}));

const t0 = performance.now();
store.ingestMembers({ adapterInstance: 'bench', members, generation: '1:1:1' });
const ingest_ms = performance.now() - t0;

const t1 = performance.now();
const snap = store.exportSnapshot();
const snapshot_ms = performance.now() - t1;

const t2 = performance.now();
const built = broker.buildReport(eng.engagement_id);
const report_ms = performance.now() - t2;

const t3 = performance.now();
const verify = broker.verifyReport(eng.engagement_id, built.markdown);
const verify_ms = performance.now() - t3;

// 审计导出（门闸判定量大时的落盘成本）
store.appendGateLog({ decision: 'bench', detail: 'bench row' });
const t4 = performance.now();
const audit = broker.auditExport(eng.engagement_id, { outDir: join(home, 'bench-audit') });
const audit_export_ms = performance.now() - t4;

// JSON 报告（结构化视图）
const t5 = performance.now();
const jsonReport = broker.exportReport(eng.engagement_id, { outDir: join(home, 'bench-report'), format: 'json' });
const json_report_ms = performance.now() - t5;

// 喷洒矩阵展开（凭据 × 服务 × 账号）
const t6 = performance.now();
const matrix = broker.sprayMatrix(eng.engagement_id, {
  credentials: Array.from({ length: 50 }, (_, i) => `sec_${i}`),
  services: Array.from({ length: 10 }, (_, i) => `svc_${i}`),
  accounts: ['root', 'admin'],
});
const matrix_ms = performance.now() - t6;

// 证据落盘（报告 + 水位 + 三段式索引）
const t7 = performance.now();
const evidence = broker.exportEvidence(eng.engagement_id, { outDir: join(home, 'bench-evidence') });
const evidence_export_ms = performance.now() - t7;

// 备份（全库一致性快照 + 完整性校验）
const t8 = performance.now();
const backup = backupHome({ home, dest: join(home, 'bench-backup') });
const backup_ms = performance.now() - t8;

const checks = [
  ['事实入库', ingest_ms, THRESHOLDS.ingest_ms, store.effectiveCount() === N],
  ['快照导出', snapshot_ms, THRESHOLDS.snapshot_ms, snap.rows.length === N],
  ['报告生成(md)', report_ms, THRESHOLDS.report_ms, built.markdown.includes('IOC')],
  ['复现校验', verify_ms, THRESHOLDS.verify_ms, verify.reproducible === true],
  ['审计导出', audit_export_ms, THRESHOLDS.audit_export_ms, audit.lines >= 1],
  ['报告生成(json)', json_report_ms, THRESHOLDS.json_report_ms, !!jsonReport.paths.json],
  ['喷洒矩阵(50×10×2)', matrix_ms, THRESHOLDS.matrix_ms, matrix.summary.cells === 1000],
  ['证据落盘', evidence_export_ms, THRESHOLDS.evidence_export_ms, !!evidence.files.index],
  ['备份(全库)', backup_ms, THRESHOLDS.backup_ms, backup.ok === backup.total],
];
const failed = checks.filter(([, ms, limit, ok]) => ms > limit || !ok);

if (v.json) {
  console.log(JSON.stringify({
    n: N,
    timings: { ingest_ms, snapshot_ms, report_ms, verify_ms, audit_export_ms, json_report_ms, matrix_ms, evidence_export_ms, backup_ms },
    failed: failed.length,
  }, null, 2));
} else {
  console.log(`规模冒烟（N=${N}）：`);
  for (const [name, ms, limit, ok] of checks) {
    console.log(`  ${ok && ms <= limit ? '[✓]' : '[✗]'} ${name}: ${ms.toFixed(1)}ms（阈值 ${limit}ms）`);
  }
  console.log(`内存 RSS：${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)}MB`);
}
process.exitCode = failed.length ? 1 : 0;
