#!/usr/bin/env node
// 故障注入矩阵（CI 闸）：node scripts/fault-matrix.mjs [--describe]
//   --describe：只列出场景表（场景 / 期望行为 / 对应契约），供文档生成与外部评审使用
import { runFaultMatrix, SCENARIOS } from '../packages/warroom-core/src/testing/faults.js';

if (process.argv.includes('--describe')) {
  for (const sc of SCENARIOS) {
    console.log(`${sc.n}\t${sc.name}\t${sc.expects}\t${sc.contract}`);
  }
  process.exit(0);
}

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
