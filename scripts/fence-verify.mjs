#!/usr/bin/env node
// 桶 A 容器围栏验收（ADR-001 验收 5）：能真测就真测，daemon 不可用就如实 SKIP。
// 用法：node scripts/fence-verify.mjs --engagement <id> --home <warroom-home> [--socks socks5://127.0.0.1:1080]
//      不提供 --socks 时使用占位 route（仅验证拓扑，不做真实代理）
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { buildFencePlan, verifyFencePlan, runFenceVerification } from '../packages/warroom-core/src/fence.js';

const { values: v } = parseArgs({
  args: process.argv.slice(2),
  options: {
    engagement: { type: 'string' }, home: { type: 'string' },
    socks: { type: 'string' }, image: { type: 'string' }, json: { type: 'boolean', default: false },
    // CI 用：daemon 不可用时把 SKIP 视为失败（防止"静默通过"）
    'require-daemon': { type: 'boolean', default: false },
  },
});

const engagementId = v.engagement;
if (!engagementId) {
  console.error('用法：node scripts/fence-verify.mjs --engagement <id> [--socks socks5://127.0.0.1:1080]');
  process.exit(2);
}

const plan = buildFencePlan({
  engagementId,
  route: { socks: v.socks ?? 'socks5://127.0.0.1:1080', route_id: 'manual' },
  image: v.image ?? 'alpine:latest',
});

const stat = verifyFencePlan(plan);
if (!stat.ok) {
  console.error('[✗] 静态不变量不通过：');
  for (const e of stat.errors) console.error(`    - ${e}`);
  process.exit(1);
}

const run = (args) => {
  try {
    const out = execFileSync(args[0], args.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` };
  }
};

const r = runFenceVerification({ plan, run });
if (v.json) console.log(JSON.stringify({ plan: { network: plan.network, sidecar: plan.sidecar, task: plan.task }, result: r }, null, 2));
else {
  console.log(`围栏网络：${plan.network.name}（internal）  上游：${plan.sidecar.upstream}`);
  console.log('静态保证：');
  for (const g of stat.guarantees) console.log(`  ✓ ${g}`);
  console.log(`\n运行时验收：${r.status}${r.reason ? `（${r.reason}）` : ''}`);
  for (const s of r.steps) console.log(`  ${s.skipped ? '[skip]' : s.ok ? '[✓]' : '[✗]'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
}
if (r.status === 'skipped' && v['require-daemon']) {
  console.error('[✗] --require-daemon：daemon 不可用，无法完成真实围栏验收（视为失败）');
  process.exitCode = 1;
} else {
  process.exitCode = r.status === 'failed' ? 1 : 0;
}
