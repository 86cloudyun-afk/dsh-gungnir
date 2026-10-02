#!/usr/bin/env node
// 外部 CI 用的薄门禁：把「交付门禁」包成一条可调用的命令。
// 读环境变量或参数（WARROOM_HOME / WARROOM_ENGAGEMENT / GUNGNIR_GATE_PROFILE），
// 输出人类可读结论 + JSON（可选），退出码：0 通过 / 1 未通过 / 2 用法或前置错误。
//
// 例（GitHub Actions）：
//   - run: node scripts/gate-check.mjs
//     env: { WARROOM_HOME: ${{ vars.WARROOM_HOME }}, WARROOM_ENGAGEMENT: ${{ vars.ENG_ID }} }
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { renderChecklist } from '../packages/warroom-core/src/checklist.js';

const { values: v } = parseArgs({
  args: process.argv.slice(2),
  options: {
    home: { type: 'string' }, engagement: { type: 'string' },
    profile: { type: 'string' }, json: { type: 'boolean', default: false },
  },
});

const home = v.home ?? process.env.WARROOM_HOME;
const engagement = v.engagement ?? process.env.WARROOM_ENGAGEMENT;
const profile = v.profile ?? process.env.GUNGNIR_GATE_PROFILE ?? 'delivery';

if (!home || !engagement) {
  console.error('[✗] 需要 --home/--engagement 或环境变量 WARROOM_HOME/WARROOM_ENGAGEMENT');
  process.exit(2);
}
if (!existsSync(home)) {
  console.error(`[✗] 家目录不存在：${home}`);
  process.exit(2);
}

let result;
try {
  const broker = new Broker({ home });
  const c = broker.checklist(engagement, { profile });
  result = {
    engagement_id: engagement, profile, deliverable: c.deliverable,
    done: c.done, total: c.total, manual: c.manual, blocked: c.blocked,
    generated_at: new Date().toISOString(),
  };
  if (!v.json) {
    console.log(renderChecklist(c));
    console.log('');
  }
} catch (e) {
  console.error(`[✗] 门禁执行失败：${e.message}`);
  process.exit(2);
}

if (v.json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`门禁结论（${profile}）：${result.deliverable ? '✅ 通过' : `⬜ 未通过（${result.blocked.length} 项）`}`);
  for (const b of result.blocked) console.log(`  - ${b}`);
}
process.exitCode = result.deliverable ? 0 : 1;
