// 自举链路回归：**只用工具面**从"零"走到"可派单"。
// 背景（真机事故 2026-10-02）：GUNGNIR 会话只有查询类工具，无法建战役、无法取出口，
// 四条线全部 blocked、目标零流量。本测试把"会话必须能自举"钉死：
//   warroom_engage → warroom_jumps(import) → warroom_jumps(acquire) → warroom_egress_check(record)
//   → warroom_execute 成功派单 → preflight 不再 blocked
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { TOOLS } from '../packages/warroom-tools/src/index.js';
import { createWarroomService } from '../packages/warroom-plugin/src/service.js';

const tool = (name) => TOOLS.find((t) => t.name === name);

function freshCore() {
  const home = mkdtempSync(join(tmpdir(), 'wr-bootstrap-'));
  const svc = createWarroomService({ home, adapterKind: 'fake' });
  return { home, svc, cleanup: () => { try { svc.broker.global.close(); } catch {} rmSync(home, { recursive: true, force: true }); } };
}

test('工具面自举：engage → jumps import → acquire → egress record → execute 派单', () => {
  const c = freshCore();
  try {
    // 1) 冻结授权（开工指令即授权事件）
    const eng = tool('warroom_engage').run(c.svc, {
      targets: ['ctf.example.test'], user_message_id: 'session-bootstrap-test', rhythm: 'restricted',
    });
    assert.equal(eng.engagement_id.startsWith('eng_'), true);
    assert.equal(eng.auth_version, 1);
    assert.ok(eng.auth_hash);
    assert.deepEqual(eng.scope, ['ctf.example.test']);
    assert.ok(eng.next.some((n) => n.includes('warroom_jumps')), '必须给出下一步自举指引');

    // 2) 登记跳板（hosts 来自操作员台账）
    const imported = tool('warroom_jumps').run(c.svc, {
      engagement_id: eng.engagement_id, action: 'import',
      hosts: [{ id: 'jh-1', addr_v4: '203.0.113.9', role: 'pure-relay', quota: 3 }],
    });
    assert.equal(imported.imported, 1);

    // 3) 取出口路由
    const route = tool('warroom_jumps').run(c.svc, {
      engagement_id: eng.engagement_id, action: 'acquire', target: 'ctf.example.test',
    });
    assert.ok(route.route_id, '必须真的拿到路由');
    assert.match(String(route.socks ?? ''), /socks5:\/\//, '路由要给出 socks 出口');

    // 4) 出口现测并记录
    const egress = tool('warroom_egress_check').run(c.svc, {
      engagement_id: eng.engagement_id, action: 'record', jumphost_id: 'jh-1',
      exit_ip: '203.0.113.9', route_id: route.route_id, verdict: 'pass',
    });
    assert.ok(egress);

    // 5) 派单成功（四元组来自冻结的授权对象）
    const dispatched = tool('warroom_execute').run(c.svc, {
      engagement_id: eng.engagement_id, command_id: 'boot-1', action_class: 'active',
      auth_version: eng.auth_version,
      contract: { targets: ['ctf.example.test'], action_class: 'active', resources: [], wire_cost: 1 },
    });
    assert.ok(dispatched.task_id, '必须真的派出任务而不是被门禁拦下');

    // 6) 预检不再 blocked
    const pf = tool('warroom_preflight').run(c.svc, { engagement_id: eng.engagement_id });
    assert.notEqual(pf.verdict, 'blocked', `不应再 blocked：${JSON.stringify(pf.blockers ?? [])}`);

    // 7) 台账可读（会话能自证状态）
    const st = tool('warroom_jumps').run(c.svc, { engagement_id: eng.engagement_id, action: 'status' });
    const routeCount = Array.isArray(st.routes) ? st.routes.length : (st.route_count ?? 0);
    assert.ok(routeCount >= 1, `台账里必须能看到刚取的路由：${JSON.stringify(st).slice(0, 200)}`);
  } finally { c.cleanup(); }
});

test('自举动词的边界：engage 必须有 targets；import 必须有 hosts；acquire 必须有 target', () => {
  const c = freshCore();
  try {
    assert.throws(() => tool('warroom_engage').run(c.svc, { targets: [], user_message_id: 'x' }), /非空 targets/);
    const eng = tool('warroom_engage').run(c.svc, { targets: ['a.test'], user_message_id: 's' });
    assert.throws(() => tool('warroom_jumps').run(c.svc, { engagement_id: eng.engagement_id, action: 'import', hosts: [] }), /需要 hosts/);
    assert.throws(() => tool('warroom_jumps').run(c.svc, { engagement_id: eng.engagement_id, action: 'acquire' }), /需要 target/);
    // 未登记跳板就取出口 → 明确失败（不编造出口）
    assert.throws(() => tool('warroom_jumps').run(c.svc, { engagement_id: eng.engagement_id, action: 'acquire', target: 'a.test' }),
      (e) => /no usable jumphost|E_NO_JUMPHOST/i.test(String(e.code ?? e.message)));
  } finally { c.cleanup(); }
});

test('两个工具都在预设允许清单里（否则会话根本看不到，自举无从谈起）', () => {
  const allow = new Set(JSON.parse(readFileSync('presets/warroom.preset.json', 'utf8')).toolPolicy.allow);
  assert.ok(allow.has('warroom_engage'), 'warroom_engage 必须在允许清单');
  assert.ok(allow.has('warroom_jumps'), 'warroom_jumps 必须在允许清单');
  for (const name of ['warroom_engage', 'warroom_jumps']) {
    assert.ok(TOOLS.some((t) => t.name === name), `${name} 必须在工具表里`);
  }
});
