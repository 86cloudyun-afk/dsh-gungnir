#!/usr/bin/env node
// 单命令门禁：顺序跑齐六道闸，**只以汇总行判定成败**，任一失败即非零退出。
// 存在理由：本项目踩过"用管道里 grep 的退出码当门禁"的坑（grep 命中失败行仍返回 0）——
// 把判定收进脚本，人工无法再走错路。
//
// 用法：
//   node scripts/ci.mjs            # 全跑
//   node scripts/ci.mjs --list     # 只列闸门
//   node scripts/ci.mjs --only <name>[,<name>]
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const GATES = [
  { name: 'test', cmd: ['node', '--test'], summary: /^# (pass|fail)/m, desc: '验收套件（node --test）' },
  { name: 'tool-schema', cmd: ['node', 'scripts/validate-tool-schemas.mjs'], desc: '工具 schema 校验' },
  { name: 'preset', cmd: ['node', 'scripts/check-preset.mjs'], desc: '预设允许清单闭合' },
  { name: 'fault-matrix', cmd: ['node', 'scripts/fault-matrix.mjs'], desc: '故障注入矩阵' },
  { name: 'docs', cmd: ['node', 'scripts/gen-docs.mjs', '--check'], desc: '工具文档与 schema 导出同步' },
  { name: 'self-review', cmd: ['node', 'scripts/self-review.mjs'], desc: '秘密/链接/验收引用/代码卫生' },
];

const { values: v } = parseArgs({
  args: process.argv.slice(2),
  options: {
    list: { type: 'boolean', default: false },
    only: { type: 'string' },
    // 只看汇总（无需管道 tail —— 管道会吞掉退出码，那正是本项目踩过的坑）
    quiet: { type: 'boolean', default: false },
    summary: { type: 'boolean', default: false },
  },
});

if (v.list) {
  for (const g of GATES) console.log(`${g.name.padEnd(14)} ${g.desc}`);
  process.exit(0);
}

const only = v.only ? new Set(v.only.split(',').map((s) => s.trim())) : null;
const selected = only ? GATES.filter((g) => only.has(g.name)) : GATES;
if (only && selected.length === 0) {
  console.error(`[✗] --only 没匹配到任何闸门（可用：${GATES.map((g) => g.name).join(',')}）`);
  process.exit(2);
}

const showGateHeaders = !v.quiet;
const results = [];
for (const gate of selected) {
  if (showGateHeaders) process.stdout.write(`\n=== ${gate.name}：${gate.desc} ===\n`);
  const t0 = Date.now();
  const r = spawnSync(gate.cmd[0], gate.cmd.slice(1), {
    stdio: v.quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit',
    env: process.env,
  });
  if (v.quiet && r.status !== 0 && r.stderr) process.stderr.write(String(r.stderr).slice(-2000));
  const ms = Date.now() - t0;
  results.push({ name: gate.name, code: r.status ?? 1, ms });
}

console.log('\n=== 门禁汇总 ===');
for (const r of results) {
  console.log(`  ${r.code === 0 ? '[✓]' : '[✗]'} ${r.name.padEnd(14)} 退出码 ${r.code}（${r.ms}ms）`);
}
const failed = results.filter((r) => r.code !== 0);
console.log(`\n结论：${failed.length === 0 ? '全部通过' : `${failed.length} 道闸失败：${failed.map((f) => f.name).join(',')}`}`);
process.exitCode = failed.length === 0 ? 0 : 1;
