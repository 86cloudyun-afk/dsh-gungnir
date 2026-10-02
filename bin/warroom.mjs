#!/usr/bin/env node
// GUNGNIR CLI：不依赖 DSH 的离线入口（框架 §11「真实链路」的最小可跑形态）。
// 用法：node bin/warroom.mjs <命令> [选项]；默认 home = $WARROOM_HOME 或 ./.warroom
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { JumphostManager } from '../packages/warroom-core/src/jumphosts.js';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';
import { RedteamModeAdapter, LocalRedteamDriver } from '../packages/warroom-core/src/adapters/redteam-mode.js';
import { rehydrate } from '../packages/warroom-core/src/rehydrate.js';

const COMMANDS = ['init', 'backup', 'restore', 'maintain', 'fact', 'egress', 'conformance', 'heartbeat', 'preflight', 'aggregate', 'timeline', 'engage', 'exec', 'collect', 'status', 'cancel', 'revoke', 'report', 'verify-report', 'evidence', 'audit', 'wave', 'sweep', 'doctor', 'config',
  'secret', 'jump', 'shell', 'spray', 'metrics', 'help'];

function usage() {
  console.log(`GUNGNIR CLI · 100% 红队工具，仅限授权测试

用法：node bin/warroom.mjs <命令> [选项]

  timeline  战役时序（只读）：--engagement <id> [--limit n] [--text]
  aggregate 跨会话聚合视图（只读：本框架各战役 + DSH 聚合库）：
            [--sessions-db <path>] [--out <file>]
  preflight 开工前预检：--engagement <id> [--meeting <wave.json>] [--record] → ready|degraded|blocked
            （给了会议文件就逐个核对波次目标是否在授权范围内）
  heartbeat  长时任务心跳：--engagement <id> --task <task_id> [--note n]
  conformance  adapter 一致性套件自检：[--module <path>]
  egress    出口验证：status | record --jumphost <id> --ip <ip> [--verdict pass|fail] [--route r]
  fact      事实查询（只读）：--engagement <id> [--type t] [--source s] [--since iso]
            [--history] [--adapter a] [--limit n]
  backup    备份家目录全部库（一致性快照 + 完整性校验）：[--out <dir>] [--keep N]
  restore   恢复演练/落地：[--from <backup dir>] [--apply]（默认 dry-run，只给计划）
  maintain  维护动作：WAL 检查点 + 完整性自检
  init      首启向导：建 home、写示例配置、导入跳板示例、建首个战役，打印下一步
  engage    创建战役（开工指令即授权）：--target <t[,t2]> [--rhythm r] [--window-hours n] [--user-msg id]
  exec      派发任务：--engagement <id> --command-id <cid> --target <t> [--intent recon] [--class active]
                      [--wire n] [--resources container] [--action-class X] [--approval <id>]
  collect   收回归执：--engagement <id> --task <tid>
  status    任务全景：--engagement <id> --task <tid>
  cancel    取消（清单逐项证实）：--engagement <id> --task <tid> [--reason r]
  revoke    撤销授权并级联停止：--engagement <id>
  report    导出报告：--engagement <id> [--out <dir>]
  verify-report  复现校验：<report.md> --engagement <id>
  config    家目录配置：show|init [--force]（默认节奏档/超时/adapter 等）
  doctor    一键体检（环境/数据/秘密）：--home <dir>（不依赖战役）
  audit     审计查询/导出：--engagement <id> [--decision <d>] [--since <iso>] [--limit n] [--offset n]
            [--order asc|desc] [--export <dir>] [--format jsonl|csv]
  evidence  证据落盘（报告+水位+三段式 EVIDENCE_INDEX）：--engagement <id> [--out <dir>] [--target <name>]
  sweep     超时治理：--engagement <id> [--timeout-min n]（超时任务转 unknown，不自动重试）
  wave      执行一波（会议纪要落库 → 依赖立即交接）：--engagement <id> --meeting <file.json> [--dry-run]
  shell     status|proof|verify：shell 三字段（--proof X / --validity unknown|likely|confirmed_lost）
  spray     check|record：喷洒断点与登记（--credential-ref --service --account [--result r]）
  metrics   效率遥测：--engagement <id> [--command-id <cid> --tokens-in n --tokens-out n --wall-time-ms n --verified-facts n --role r]
  secret    put|grant|status|rotate（rotate 需 --confirm）
  jump      import|acquire|list|status|release|heartbeat|sweep|sweep-routes
  adapter   fake|redteam（默认 fake）

全局：--home <dir>（默认 $WARROOM_HOME 或 ./.warroom） --json --help`);
}

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';
if (command === 'help' || argv.includes('--help') || command === '-h') { usage(); process.exit(0); }
if (!COMMANDS.includes(command)) { console.error(`未知命令：${command}\n`); usage(); process.exit(2); }

const { values: v } = parseArgs({
  args: argv.slice(1),
  options: {
    home: { type: 'string' }, json: { type: 'boolean', default: false },
    target: { type: 'string' }, targets: { type: 'string' }, rhythm: { type: 'string' },
    'window-hours': { type: 'string' }, 'user-msg': { type: 'string' },
    engagement: { type: 'string' }, 'command-id': { type: 'string' }, task: { type: 'string' },
    intent: { type: 'string' }, class: { type: 'string' }, 'action-class': { type: 'string' },
    wire: { type: 'string' }, resources: { type: 'string' }, approval: { type: 'string' },
    reason: { type: 'string' }, out: { type: 'string' }, adapter: { type: 'string' },
    label: { type: 'string' }, plaintext: { type: 'string' }, 'secret-ref': { type: 'string' },
    purpose: { type: 'string' }, 'ttl-seconds': { type: 'string' }, id: { type: 'string' },
    host: { type: 'string' }, 'addr-v4': { type: 'string' },
    proof: { type: 'string' }, validity: { type: 'string' }, route: { type: 'string' },
    'credential-ref': { type: 'string' }, service: { type: 'string' }, account: { type: 'string' },
    result: { type: 'string' }, role: { type: 'string' },
    'tokens-in': { type: 'string' }, 'tokens-out': { type: 'string' },
    'wall-time-ms': { type: 'string' }, 'verified-facts': { type: 'string' },
    format: { type: 'string' }, meeting: { type: 'string' }, 'timeout-min': { type: 'string' },
    decision: { type: 'string' }, since: { type: 'string' }, limit: { type: 'string' }, export: { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, offset: { type: 'string' }, order: { type: 'string' },
    'with-jumphost-sample': { type: 'boolean', default: false }, force: { type: 'boolean', default: false },
    confirm: { type: 'boolean', default: false }, 'max-facts': { type: 'string' },
    keep: { type: 'string' }, from: { type: 'string' }, apply: { type: 'boolean', default: false },
    'sessions-db': { type: 'string' }, record: { type: 'boolean', default: false },
    audience: { type: 'string' }, text: { type: 'boolean', default: false },
    type: { type: 'string' }, source: { type: 'string' }, history: { type: 'boolean', default: false },
    adapter: { type: 'string' }, jumphost: { type: 'string' }, ip: { type: 'string' },
    verdict: { type: 'string' }, module: { type: 'string' }, task: { type: 'string' }, note: { type: 'string' },
  },
  allowPositionals: true,
});

const home = v.home ?? process.env.WARROOM_HOME ?? join(process.cwd(), '.warroom');
const out = (obj) => { console.log(v.json ? JSON.stringify(obj, null, 2) : obj); };

function makeAdapter(kind) {
  const which = kind ?? v.adapter ?? 'fake';
  if (which === 'redteam') {
    return new RedteamModeAdapter({
      driver: new LocalRedteamDriver(),
      roleByIntent: { recon: 'recon', assess: 'assess', vuln: 'vuln', exploit: 'exploit', internal: 'internal' },
    });
  }
  return new FakeAdapter();
}

const broker = new Broker({ home, adapter: makeAdapter(v.adapter) });
// 跨进程再水化：非终态命令在 adapter 侧重建任务（CLI 每次调用是新进程）
rehydrate(broker);
const jumps = new JumphostManager({
  globalDb: broker.global,
  getFactStore: (id) => broker._eng(id).store,
});

const need = (name, val) => { if (!val) { console.error(`缺少 --${name}`); process.exit(2); } return val; };

switch (command) {
  case 'timeline': {
    const { renderTimeline } = await import('../packages/warroom-core/src/timeline.js');
    const tl = broker.timeline(need('engagement', v.engagement));
    if (v.text || !v.json) {
      console.log(renderTimeline(tl, { limit: v.limit ? Number(v.limit) : 200 }));
      if (v.json) out(tl);
    } else out(tl);
    break;
  }
  case 'aggregate': {
    const { aggregateView } = await import('../packages/warroom-core/src/aggregate.js');
    const view = aggregateView({ home, sessionsDbPath: v['sessions-db'] ?? null });
    if (v.out) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(v.out, JSON.stringify(view, null, 2) + '\n', 'utf8');
      out({ path: v.out, totals: view.totals, dsh_sessions: view.dsh_sessions });
    } else out(view);
    break;
  }
  case 'preflight': {
    let meeting = null;
    if (v.meeting) {
      const { readFileSync } = await import('node:fs');
      meeting = JSON.parse(readFileSync(v.meeting, 'utf8'));
    }
    const r = broker.preflight(need('engagement', v.engagement), { meeting, record: v.record === true });
    out(r);
    if (r.verdict === 'blocked') process.exitCode = 1;
    break;
  }
  case 'heartbeat':
    out(broker.heartbeat(need('engagement', v.engagement), need('task', v.task), { note: v.note ?? null }));
    break;
  case 'conformance': {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('node', ['scripts/conformance.mjs', ...(v.module ? ['--module', v.module] : []), ...(v.json ? ['--json'] : [])], { encoding: 'utf8' });
    process.stdout.write(r.stdout);
    if (r.status !== 0) process.exit(r.status ?? 1);   // 失败项存在时脚本已置非零退出码
    break;
  }
  case 'egress': {
    const sub = argv[1] ?? 'status';
    if (sub === 'record') {
      out(broker.recordEgressCheck(need('engagement', v.engagement), {
        jumphost_id: need('jumphost', v.jumphost), exit_ip: need('ip', v.ip),
        route_id: v.route ?? null, verdict: v.verdict ?? 'pass',
      }));
    } else out(broker.egressStatus(need('engagement', v.engagement)));
    break;
  }
  case 'fact': {
    const { store } = broker._eng(need('engagement', v.engagement));
    out(store.queryFacts({
      entityType: v.type ?? null, sourceId: v.source ?? null, since: v.since ?? null,
      includeHistory: !!v.history, adapterInstance: v.adapter ?? null,
      limit: v.limit ? Number(v.limit) : 500,
    }));
    break;
  }
  case 'backup': {
    const { backupHome, latestBackup } = await import('../packages/warroom-core/src/maintenance.js');
    const r = backupHome({ home, dest: v.out ?? null, keep: v.keep ? Number(v.keep) : null });
    out({ ...r, latest: latestBackup({ home })?.name ?? null });
    if (r.ok !== r.total) process.exitCode = 1;
    break;
  }
  case 'restore': {
    const { restoreHome } = await import('../packages/warroom-core/src/maintenance.js');
    if (!v.from) { console.error('restore 需要 --from <backup dir>'); process.exit(2); }
    const r = restoreHome({ home, from: v.from, dryRun: !v.apply, broker });
    out(r);
    if (r.warnings.some((w) => w.includes('完整性异常') || w.includes('没有可恢复'))) process.exitCode = 1;
    break;
  }
  case 'maintain': {
    const { checkpointHome } = await import('../packages/warroom-core/src/maintenance.js');
    const rows = checkpointHome({ home });
    out({ databases: rows, ok: rows.every((r) => r.integrity === 'ok') });
    break;
  }
  case 'init': {
    const { writeExampleConfig, configPath, loadConfig } = await import('../packages/warroom-core/src/config.js');
    const { mkdirSync, existsSync } = await import('node:fs');
    const steps = [];
    mkdirSync(home, { recursive: true });
    steps.push(`✓ 家目录就绪：${home}`);

    const cfgExists = existsSync(configPath(home));
    if (!cfgExists || argv.includes('--force')) {
      const w = writeExampleConfig(home, { force: cfgExists, overrides: v.rhythm ? { rhythm: v.rhythm } : {} });
      steps.push(`✓ 已写配置：${w.path}（rhythm=${w.config.rhythm}）`);
    } else {
      steps.push(`· 配置已存在，保留：${configPath(home)}`);
    }

    // 跳板示例（占位地址，真实部署请替换；导入后表即真源）
    if (argv.includes('--with-jumphost-sample')) {
      jumps.importHosts([{ id: 'jh-sample', addr_v4: '203.0.113.10', ssh_host: '203.0.113.10' }]);
      steps.push('✓ 已导入跳板示例 jh-sample（占位地址 203.0.113.10，请替换为你的跳板）');
    }

    // 首个战役（可选：给了 --target 才建）
    if (v.target) {
      const targets = (v.targets ?? v.target).split(',').filter(Boolean);
      const cfg = loadConfig(home);
      const r = broker.createEngagement({
        user_message_id: v['user-msg'] ?? `init-${Date.now()}`,
        targets,
        overrides: v.rhythm ? { rhythm: v.rhythm } : { rhythm: cfg.rhythm },
      });
      steps.push(`✓ 已建战役：${r.engagement_id}（目标 ${targets.join(', ')}，rhythm=${r.auth_object.rhythm}）`);
    }

    const next = [
      '下一步：',
      '  1) 体检：        node bin/warroom.mjs doctor',
      v.target ? '  2) 演练一波：    node bin/warroom.mjs wave --dry-run --engagement <id> --meeting wave.json'
               : '  2) 建战役：      node bin/warroom.mjs engage --target <目标或CIDR>',
      '  3) 派单：        node bin/warroom.mjs exec --engagement <id> --command-id c1 --target <资产> --class readonly',
      '  4) 报告与证据：  node bin/warroom.mjs report --engagement <id> --format both',
      '                  node bin/warroom.mjs evidence --engagement <id> --out <dir>',
    ];
    if (v.json) out({ home, steps, next });
    else {
      for (const s2 of steps) console.log(s2);
      console.log('');
      for (const n of next) console.log(n);
    }
    break;
  }
  case 'config': {
    const { loadConfig, writeExampleConfig, configPath } = await import('../packages/warroom-core/src/config.js');
    const sub = argv[1] ?? 'show';
    if (sub === 'init') out(writeExampleConfig(home, { force: argv.includes('--force') }));
    else out({ path: configPath(home), config: loadConfig(home) });
    break;
  }
  case 'doctor': {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('node', ['scripts/doctor.mjs', '--home', home, ...(v.json ? ['--json'] : [])], { encoding: 'utf8' });
    process.stdout.write(r.stdout);
    if (r.status !== 0) process.exit(r.status ?? 1);
    break;
  }
  case 'engage': {
    const targets = (v.targets ?? v.target ?? '').split(',').filter(Boolean);
    const overrides = {};
    if (v.rhythm) overrides.rhythm = v.rhythm;
    if (v['window-hours']) overrides.window_hours = Number(v['window-hours']);
    const r = broker.createEngagement({
      user_message_id: v['user-msg'] ?? `cli-${Date.now()}`,
      targets,
      overrides,
    });
    out({ engagement_id: r.engagement_id, auth_version: r.auth_version, targets, rhythm: r.auth_object.rhythm });
    break;
  }
  case 'exec': {
    const contract = {
      targets: [need('target', v.target)],
      action_class: v['action-class'] ?? v.class ?? 'readonly',
      wire_cost: v.wire ? Number(v.wire) : 0,
      resources: v.resources ? v.resources.split(',').filter(Boolean) : [],
      intent: v.intent ?? 'recon',
    };
    const r = broker.execute({
      command_id: need('command-id', v['command-id']),
      engagement_id: need('engagement', v.engagement),
      auth_version: broker._auth(v.engagement).row.auth_version,
      contract,
      manual_approval_token: v.approval,
    });
    out(r);
    break;
  }
  case 'collect': {
    const taskId = need('task', v.task);
    const receipt = broker.adapter.collect(taskId);
    out(broker.collect(need('engagement', v.engagement), taskId, receipt));
    break;
  }
  case 'status':
    out(broker.status(need('engagement', v.engagement), need('task', v.task)));
    break;
  case 'cancel':
    out(broker.cancel(need('engagement', v.engagement), need('task', v.task), v.reason ?? 'cli'));
    break;
  case 'revoke':
    out(broker.revoke(need('engagement', v.engagement), v.reason ?? 'cli'));
    break;
  case 'report':
    out(broker.exportReport(need('engagement', v.engagement), {
      outDir: v.out, format: v.format ?? 'md',
      maxFactsPerType: v['max-facts'] ? Number(v['max-facts']) : 50,
      audience: v.audience ?? 'full',
    }));
    break;
  case 'audit': {
    const engagementId = need('engagement', v.engagement);
    if (v.export) {
      out(v.format === 'csv'
        ? broker.auditExportCsv(engagementId, { outDir: v.export, decision: v.decision ?? null, since: v.since ?? null })
        : broker.auditExport(engagementId, { outDir: v.export }));
    } else {
      out(broker.audit(engagementId, {
        decision: v.decision ?? null, since: v.since ?? null,
        limit: v.limit ? Number(v.limit) : 200,
        offset: v.offset ? Number(v.offset) : 0,
        order: v.order ?? 'desc',
      }));
    }
    break;
  }
  case 'evidence':
    out(broker.exportEvidence(need('engagement', v.engagement), {
      outDir: v.out, target: v.target,
      audiences: v.audience ? [v.audience] : ['client', 'blue'],
    }));
    break;
  case 'sweep':
    out(broker.sweepTimeouts(need('engagement', v.engagement), {
      timeoutMs: v['timeout-min'] ? Number(v['timeout-min']) * 60 * 1000 : null, // null → 取家目录配置
    }));
    break;
  case 'wave': {
    const { readFileSync } = await import('node:fs');
    const { runWave, listMeetings } = await import('../packages/warroom-core/src/wave.js');
    const file = v.meeting ?? argv[1];   // 支持 --meeting <file> 或位置参数
    if (!file) { console.error('wave 需要会议文件 JSON（{title, notes, tasks:[…]}）：--meeting <file>'); process.exit(2); }
    const plan = JSON.parse(readFileSync(file, 'utf8'));
    const r = runWave({ broker, engagementId: need('engagement', v.engagement), wave: plan, dryRun: !!v['dry-run'] });
    if (r.dry_run) out(r);
    else out({ ...r, meetings: listMeetings({ store: broker._eng(v.engagement).store }).length });
    break;
  }
  case 'verify-report': {
    const { readFileSync } = await import('node:fs');
    const reportPath = argv[1];
    if (!reportPath) { console.error('verify-report 需要报告路径'); process.exit(2); }
    out(broker.verifyReport(need('engagement', v.engagement), readFileSync(reportPath, 'utf8')));
    break;
  }
  case 'shell': {
    const sub = argv[1];
    const engagementId = need('engagement', v.engagement);
    if (sub === 'status') out(broker.shell(engagementId) ?? { highest_proof: null, current_validity: 'unknown', last_verified_at: null });
    else if (sub === 'proof') out(broker.recordShellProof(engagementId, { proof: need('proof', v.proof) }));
    else if (sub === 'verify') out(broker.verifyShell(engagementId, { validity: need('validity', v.validity) }));
    else { console.error('shell 需要 status|proof|verify'); process.exit(2); }
    break;
  }
  case 'spray': {
    const sub = argv[1];
    const engagementId = need('engagement', v.engagement);
    const args = { credential_ref: need('credential-ref', v['credential-ref']), service: need('service', v.service), account: need('account', v.account) };
    if (sub === 'check') out(broker.sprayCheck(engagementId, args));
    else if (sub === 'record') out(broker.sprayRecord(engagementId, { ...args, result: need('result', v.result) }));
    else { console.error('spray 需要 check|record'); process.exit(2); }
    break;
  }
  case 'metrics': {
    const engagementId = need('engagement', v.engagement);
    if (v['command-id']) {
      out(broker.recordMetrics(engagementId, v['command-id'], {
        tokens_in: Number(v['tokens-in'] ?? 0), tokens_out: Number(v['tokens-out'] ?? 0),
        wall_time_ms: Number(v['wall-time-ms'] ?? 0), verified_facts: Number(v['verified-facts'] ?? 0),
        role: v.role,
      }));
    } else out(broker.metrics(engagementId));
    break;
  }
  case 'secret': {
    const sub = argv[1];
    if (sub === 'put') out(broker.secrets.put(need('plaintext', v.plaintext), { label: v.label ?? 'secret' }));
    else if (sub === 'grant') {
      out(broker.secrets.grant(need('secret-ref', v['secret-ref']), {
        engagement_id: v.engagement, task_id: need('task', v.task),
        purpose: need('purpose', v.purpose), ttlSeconds: v['ttl-seconds'] ? Number(v['ttl-seconds']) : 300,
      }));
    } else if (sub === 'rotate') {
      out(broker.secrets.rotateKey());
    } else if (sub === 'sweep-routes') {
      out(jumps.sweepRoutes());
    } else if (sub === 'heartbeat') {
      out(jumps.heartbeatRoute({ route_id: need('route', v.route), engagementId: need('engagement', v.engagement) }));
    } else if (sub === 'status') {
      const secrets = broker.global.prepare('SELECT secret_ref, label, created_at FROM secret_store').all();
      const grants = v.engagement
        ? broker.global.prepare('SELECT * FROM secret_grants WHERE engagement_id = ?').all(v.engagement)
        : broker.global.prepare('SELECT * FROM secret_grants').all();
      out({ secrets, grants });
    } else { console.error('secret 需要 put|grant|status'); process.exit(2); }
    break;
  }
  case 'jump': {
    const sub = argv[1];
    if (sub === 'import') {
      jumps.importHosts([{ id: need('id', v.id), addr_v4: v['addr-v4'], ssh_host: v.host, quota: 3 }]);
      out({ imported: v.id });
    } else if (sub === 'acquire') {
      out(jumps.acquire({ engagement_id: need('engagement', v.engagement), target: need('target', v.target) }));
    } else if (sub === 'rotate') {
      out(broker.secrets.rotateKey());
    } else if (sub === 'sweep-routes') {
      out(jumps.sweepRoutes());
    } else if (sub === 'heartbeat') {
      out(jumps.heartbeatRoute({ route_id: need('route', v.route), engagementId: need('engagement', v.engagement) }));
    } else if (sub === 'status') {
      out(jumps.status(v.engagement ?? null));
    } else if (sub === 'release') {
      out(jumps.releaseRoute({ route_id: need('route', v.route), engagementId: need('engagement', v.engagement) }));
    } else if (sub === 'list') {
      out({
        hosts: broker.global.prepare('SELECT * FROM jumphosts').all(),
        leases: broker.global.prepare('SELECT * FROM leases').all(),
      });
    } else if (sub === 'sweep') {
      out(jumps.sweepExpired());
    } else { console.error('jump 需要 import|acquire|list|sweep'); process.exit(2); }
    break;
  }
  default:
    usage();
}
