#!/usr/bin/env node
// adapter 一致性套件独立入口：外部 adapter 作者可以对**自己的 adapter** 跑同一套契约检查
// （工具集与指挥层期望的 SPI rev2 语义：dispatch/collect/status/cancel/reconcile + 幂等 + 资源清单）。
//
// 用法：
//   node scripts/conformance.mjs                 # 默认对内置 fake adapter 跑（回归用）
//   node scripts/conformance.mjs --module ./my-adapter.mjs    # 对自己的 adapter 跑
//   node scripts/conformance.mjs --json
//
// 自定义 adapter 模块契约：`export default class { …SPI rev2… }` 或 `export const adapter = …`
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runConformance, summarize } from '../packages/warroom-core/src/adapters/conformance.js';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';

const { values: v } = parseArgs({
  args: process.argv.slice(2),
  options: { module: { type: 'string' }, json: { type: 'boolean', default: false } },
});

let adapter;
if (v.module) {
  const mod = await import(pathToFileURL(resolve(v.module)).href);
  const Ctor = mod.default ?? mod.Adapter ?? mod.adapter;
  if (typeof Ctor === 'function') adapter = new Ctor();
  else if (Ctor && typeof Ctor === 'object') adapter = Ctor;
  else { console.error(`[✗] 模块 ${v.module} 未导出 adapter 类/实例`); process.exit(2); }
} else {
  adapter = new FakeAdapter();
}

const results = await runConformance(adapter);
const summary = summarize(results);
if (v.json) {
  console.log(JSON.stringify({ adapter: adapter.constructor?.name ?? 'unknown', summary, results }, null, 2));
} else {
  console.log(`adapter 一致性套件：${adapter.constructor?.name ?? 'unknown'}`);
  for (const r of results) console.log(`  ${r.ok ? '[✓]' : '[✗]'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`\n结论：${summary.passed}/${summary.total} 通过`);
}
// 注意：summarize().failed 是**数组**（列出失败项），不是计数
const failedCount = Array.isArray(summary.failed) ? summary.failed.length : Number(summary.failed ?? 0);
process.exitCode = failedCount > 0 ? 1 : 0;
