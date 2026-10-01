#!/usr/bin/env node
// 故障注入矩阵（CI 闸）：node scripts/fault-matrix.mjs
import { runFaultMatrix } from '../packages/warroom-core/src/testing/faults.js';

const r = runFaultMatrix();
for (const c of r.checks) {
  console.log(`${c.ok ? '[✓]' : '[✗]'} ${c.name}${c.ok ? '' : ` — ${c.detail}`}`);
}
console.log(`\n故障矩阵：${r.passed}/${r.total} 通过`);
if (r.failed.length > 0) {
  console.error('\n失败项：');
  for (const f of r.failed) console.error(`  - ${f.name}: ${f.detail}`);
  process.exitCode = 1;
}
