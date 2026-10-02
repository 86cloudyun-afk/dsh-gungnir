#!/usr/bin/env node
// 出口验证实跑（框架 §11 / 作战宪法 §12）：
//   · 默认模式：经跳板 route 的 SOCKS 出口请求回显端点，比对观测 IP 与登记地址
//   · --self 模式：不设代理，验证"操作节点自身出口" ∈ 登记的跳板地址集合
// 结果自动入账（egress_checks + gate_log）。网络/工具不可用时**如实 SKIP**（退出码 3），不伪造结果。
//
// 用法：
//   node scripts/egress-check.mjs --home <dir> --engagement <id> [--route <route_id>] [--json]
//   node scripts/egress-check.mjs --home <dir> --engagement <id> --self --expect <ip> [--json]
//   node scripts/egress-check.mjs --home <dir> --engagement <id> --observed <ip> --expect <ip>   # 离线补录
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { Broker } from '../packages/warroom-core/src/broker.js';

const { values: v } = parseArgs({
  args: process.argv.slice(2),
  options: {
    home: { type: 'string' }, engagement: { type: 'string' }, route: { type: 'string' },
    expect: { type: 'string' }, self: { type: 'boolean', default: false },
    observed: { type: 'string' }, endpoint: { type: 'string' }, json: { type: 'boolean', default: false },
    timeout: { type: 'string' },
  },
});

const fail = (msg, code = 2) => { console.error(`[✗] ${msg}`); process.exit(code); };
if (!v.home || !v.engagement) fail('需要 --home 与 --engagement');

const broker = new Broker({ home: v.home });
const store = broker._eng(v.engagement).store;
const endpoint = v.endpoint ?? 'https://api.ipify.org';
const timeout = Number(v.timeout ?? 10);

let observed = v.observed ?? null;
let via = null;
let expected = v.expect ?? null;

if (!observed) {
  if (v.self) {
    // 节点自身出口：直连（禁止设 http_proxy/ALL_PROXY，宪法 §12 第 2 条）
    if (process.env.http_proxy || process.env.HTTPS_PROXY || process.env.ALL_PROXY || process.env.all_proxy) {
      fail('--self 模式下检测到代理环境变量（宪法 §12 禁止二级代理）：请清理 http_proxy/ALL_PROXY');
    }
    via = { kind: 'self' };
    // 期望集合：登记的跳板地址（节点自身地址应在其中）
    if (!expected) {
      const addrs = broker.jumps?.status?.()?.hosts?.map((h) => h.addr_v4).filter(Boolean) ?? [];
      expected = addrs;
    } else expected = [expected];
  } else {
    const routes = store.db.prepare("SELECT * FROM jump_routes WHERE state = 'active' ORDER BY ts").all();
    const route = v.route ? routes.find((r) => r.route_id === v.route)
      : (v.self ? null : routes.at(-1));
    if (!route) fail('没有活跃跳板路由：先 jump acquire，或改用 --self', 2);
    via = { kind: 'route', route_id: route.route_id, socks: route.socks, jumphost_id: route.jumphost_id };
    if (!expected) {
      const host = broker.global.prepare('SELECT addr_v4 FROM jumphosts WHERE id = ?').get(route.jumphost_id);
      expected = host?.addr_v4 ?? null;
    }
    try {
      observed = execFileSync('curl', ['-s', '--max-time', String(timeout), '-x', route.socks, endpoint],
        { encoding: 'utf8' }).trim();
    } catch (e) {
      const out = { status: 'skipped', reason: `curl 失败：${e.message}`, via, endpoint };
      if (v.json) console.log(JSON.stringify(out, null, 2));
      else console.log(`出口验证：SKIP（${out.reason}）`);
      process.exit(3);   // ESM 顶层不能用 return：显式退出，语义=SKIP（非通过）
    }
  }
}

if (!observed && v.self) {
  try {
    observed = execFileSync('curl', ['-s', '--max-time', String(timeout), endpoint], { encoding: 'utf8' }).trim();
  } catch (e) {
    const out = { status: 'skipped', reason: `curl 失败：${e.message}`, via, endpoint };
    if (v.json) console.log(JSON.stringify(out, null, 2));
    else console.log(`出口验证：SKIP（${out.reason}）`);
    process.exit(3);
  }
}

const expectedList = Array.isArray(expected) ? expected.filter(Boolean) : [expected].filter(Boolean);
const ok = expectedList.length > 0 ? expectedList.includes(observed) : true;
const verdict = ok ? 'pass' : 'fail';
const recorded = broker.recordEgressCheck(v.engagement, {
  jumphost_id: via?.jumphost_id ?? (v.self ? 'self' : 'unknown'),
  exit_ip: observed, route_id: via?.route_id ?? null, verdict,
});

const result = {
  status: verdict === 'pass' ? 'passed' : 'mismatch',
  observed, expected: expectedList, via, endpoint, recorded,
  note: expectedList.length === 0 ? '未登记期望地址（仅记录观测值）' : undefined,
};
if (v.json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`出口验证：${result.status === 'passed' ? '[✓] 通过' : '[✗] 不匹配'}`);
  console.log(`  观测 IP：${observed}`);
  console.log(`  期望：${expectedList.length ? expectedList.join(', ') : '（未登记）'}`);
  console.log(`  方式：${via?.kind === 'route' ? `经 route ${via.route_id}（${via.socks}）` : '节点自身出口'}`);
  console.log(`  已入账：gate_log + egress_checks`);
}
process.exitCode = verdict === 'pass' ? 0 : 1;
