#!/usr/bin/env node
// 报告复现校验（ADR-002 D4）：用报告里的水位 + 证据摘要对照当前库。
// 用法：node scripts/verify-report.mjs <report.md> --home <warroom-home> --engagement <id>
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Broker } from '../packages/warroom-core/src/broker.js';

const { values: v, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { home: { type: 'string' }, engagement: { type: 'string' }, json: { type: 'boolean', default: false } },
  allowPositionals: true,
});

const reportPath = positionals[0];
if (!reportPath || !v.home || !v.engagement) {
  console.error('用法：node scripts/verify-report.mjs <report.md> --home <warroom-home> --engagement <id>');
  process.exit(2);
}

const markdown = readFileSync(reportPath, 'utf8');
const broker = new Broker({ home: v.home });
const r = broker.verifyReport(v.engagement, markdown);

if (v.json) {
  console.log(JSON.stringify(r, null, 2));
} else {
  console.log(`报告水位: seq=${r.report.seq} snapshot=${String(r.report.snapshot_id).slice(0, 16)}…`);
  console.log(`当前库:   seq=${r.current.seq} snapshot=${String(r.current.snapshot_id).slice(0, 16)}…`);
  console.log(`证据摘要: 报告=${String(r.report.fact_members_digest).slice(0, 16)}… 当前=${String(r.current.fact_members_digest).slice(0, 16)}…`);
  console.log(r.reproducible
    ? '[✓] 报告可复现（水位与证据摘要完全一致）'
    : `[!] 报告与当前库存在漂移：seq 差 ${r.drift.seq}，当前有效行 ${r.drift.rows_now}（报告导出后库有新写入属正常；若需原地复现请回滚到该水位）`);
}
process.exitCode = r.reproducible ? 0 : 3;
