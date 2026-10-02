#!/usr/bin/env node
// 执行层落地演练：把「指挥层 ↔ 桥 ↔ 执行器」的完整链路跑一遍并逐步打印。
// 目的：让第一次接入的人（或换机器的人）**用一条命令**看到链路真的通，而不是读文档猜。
//
// 用法：
//   node scripts/executor-drill.mjs                       # fake 模式（离线，零依赖）
//   node scripts/executor-drill.mjs --mode bridge         # 桥模式：真起应答器子进程 + 示例执行器
//   node scripts/executor-drill.mjs --mode bridge --json
//
// 退出码：0 全链路通过；1 任一步失败（并把失败步骤打到 stderr）。
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';
import { RedteamModeAdapter } from '../packages/warroom-core/src/adapters/redteam-mode.js';
import { DshRedteamDriver } from '../packages/warroom-core/src/adapters/dsh-bridge.js';

const { values: v } = parseArgs({
  args: process.argv.slice(2),
  options: {
    mode: { type: 'string', default: 'fake' },
    json: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
});

const steps = [];
const step = (name, ok, detail) => {
  steps.push({ name, ok, detail });
  if (!v.json) console.log(`${ok ? '[✓]' : '[✗]'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const t0 = Date.now();
const home = mkdtempSync(join(tmpdir(), 'wr-drill-'));
const root = join(home, 'dsh-bridge');
let responder = null;
let ok = true;

try {
  // 0) 执行层就位
  let adapter;
  if (v.mode === 'bridge') {
    responder = spawn('node', ['scripts/dsh-bridge-responder.mjs', '--root', root, '--interval', '25',
      '--mode', 'echo'], { stdio: ['ignore', 'pipe', 'pipe'] });
    adapter = new RedteamModeAdapter({ driver: new DshRedteamDriver({ root, timeoutMs: 5000, pollMs: 25 }) });
    step('执行层就位（桥 + 应答器子进程）', true, `spool=${root}`);
  } else {
    adapter = new FakeAdapter();
    step('执行层就位（fake adapter，离线）', true);
  }

  const broker = new Broker({ home, adapter });
  step('宿主启动（Broker + 家目录）', true, home);

  // 1) 开工（授权对象由宿主冻结）
  const eng = broker.createEngagement({
    user_message_id: 'drill', targets: ['10.0.0.0/24'], overrides: { rhythm: 'open' },
  });
  step('开工：冻结授权对象', !!eng.auth_hash, `auth v${eng.auth_object.auth_version ?? 1} · ${eng.engagement_id}`);

  // 2) 取出口（桶 A 需要 route；这里用假跳板登记 + 真实 acquire 流程）
  const { JumphostManager } = await import('../packages/warroom-core/src/jumphosts.js');
  const jm = new JumphostManager({
    globalDb: broker.global, getFactStore: (id) => broker._eng(id).store,
    listEngagements: () => broker.listEngagements(),
  });
  jm.importHosts([{ id: 'drill-jh', addr_v4: '203.0.113.200' }]);
  const acq = jm.acquire({ engagement_id: eng.engagement_id, target: '10.0.0.5' });
  step('取出口：租约 + 路由 + 出口实测', !!acq.route_id, `${acq.route_id} · ${acq.socks}`);

  // 3) 出口验证入账
  const eg = broker.recordEgressCheck(eng.engagement_id, {
    jumphost_id: acq.jumphost_id, exit_ip: '203.0.113.200', route_id: acq.route_id,
  });
  step('出口验证：记录并判定', eg.verdict === 'pass', `verdict=${eg.verdict}`);

  // 4) 预检
  const pre = broker.preflight(eng.engagement_id);
  step('开工前预检', pre.verdict !== 'blocked', `verdict=${pre.verdict}（提示 ${pre.warnings.length} 项）`);

  // 5) 派单 → 回执 → 结项
  const ex = broker.execute({
    command_id: 'drill-1', engagement_id: eng.engagement_id, auth_version: 1, action_class: 'active',
    contract: {
      targets: ['10.0.0.5'], action_class: 'active', resources: [], wire_cost: 1, intent: 'recon',
      fake_members: [{ entity_type: 'asset', source_id: 'drill-asset', revision_no: 1, content_hash: 'h-drill', payload: { note: 'drill' } }],
    },
  });
  // 派单成功即可（常驻应答器"先确认后执行"：瞬间完成的任务此处可能已是 done）
  step('派单：账本先持久化后派发', ['running', 'done'].includes(ex.state), `task=${ex.task_id} state=${ex.state}`);

  // 桥是异步的：等执行层把事实落盘再收（最多 8 秒）
  const factsPath = join(home, 'dsh-bridge', 'inbox', `${ex.task_id}.facts.json`);
  const t0 = Date.now();
  while (!existsSync(factsPath) && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 25));

  const receipt = adapter.collect(ex.task_id);
  const ingested = broker.collect(eng.engagement_id, ex.task_id, receipt);
  step('回执入库（成员级幂等）', ingested.accepted === true, `members=${receipt.members.length}`);
  // 结项：执行器报终态后账本跟进。真实执行层通常"收完事实即收工"，因此先直接结项；
  // 若执行器尚未报终态（桥模式下 status 仍为 running），走正规流程 cancel → 远端确认停止 → 结项。
  let settled = broker.settle(eng.engagement_id, ex.task_id);
  let path = '直接结项';
  if (!settled.settled) {
    const cancelled = broker.cancel(eng.engagement_id, ex.task_id, 'drill: 收工');
    await new Promise((r) => setTimeout(r, 200));   // 给执行层写回停止证明的时间
    settled = broker.settle(eng.engagement_id, ex.task_id);
    path = `cancel→远端确认（cancel state=${cancelled.state}）`;
  }
  step('结项：执行器报终态后账本跟进', settled.settled === true, `${path} · state=${settled.ledger_state}`);

  // 6) 交付（报告 + 证据包 + 清单 + 门禁）
  const pack = broker.deliver(eng.engagement_id, { outDir: join(home, 'delivery') });
  step('一键交付：报告/证据包/清单', existsSync(pack.reports.md ?? pack.reports.markdown),
    `gate.deliverable=${pack.gate.deliverable}`);
  if (!pack.gate.deliverable) step('交付门禁', false, JSON.stringify(pack.gate.blocked));

  // 7) 视图可用性（值班/时序/油表）
  const w = broker.watch(eng.engagement_id);
  const tl = broker.timeline(eng.engagement_id);
  const rv = broker.rateView(eng.engagement_id);
  step('值班视图（watch/timeline/rate）', w.tasks.total > 0 && tl.events.length > 0,
    `在飞 ${w.tasks.in_flight.length} · 事件 ${tl.events.length} · wire ${rv.wire.used}`);
} catch (e) {
  ok = false;
  step('异常中断', false, e.message);
} finally {
  if (responder) responder.kill('SIGTERM');
  if (!v.keep) rmSync(home, { recursive: true, force: true });
}

const failed = steps.filter((s) => !s.ok);
ok = ok && failed.length === 0;
const summary = { mode: v.mode, ok, steps: steps.length, failed: failed.map((f) => f.name), ms: Date.now() - t0, home: v.keep ? home : null };
if (v.json) console.log(JSON.stringify({ ...summary, detail: steps }, null, 2));
else {
  console.log('');
  console.log(`演练结论：${ok ? '全链路通过' : `失败 ${failed.length} 步（${failed.map((f) => f.name).join('、')}）`}`
    + ` · ${steps.length} 步 · ${summary.ms}ms`);
}
process.exitCode = ok ? 0 : 1;
