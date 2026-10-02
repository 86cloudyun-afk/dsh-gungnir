// 出口现测：纪律是"测不出就是失败"——不得填历史值、不得假装通过；本机代理变量必须清掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeEgress, DEFAULT_PROBES } from '../packages/warroom-core/src/egress-probe.mjs';
import { TOOLS } from '../packages/warroom-tools/src/index.js';
import { createWarroomService } from '../packages/warroom-plugin/src/service.js';

const fakeRunner = (stdout, status = 0) => (args, { env }) => {
  assert.equal('HTTP_PROXY' in env, false, '必须清掉本机代理变量（否则静默回落本机出口）');
  assert.equal('ALL_PROXY' in env, false);
  assert.ok(args.includes('-x'), '必须显式带 -x 用 SOCKS 出口');
  return { status, stdout, stderr: status === 0 ? '' : 'boom' };
};

test('现测成功：返回实测 IP + 命中的探测服务', () => {
  const r = probeEgress({ endpoint: 'socks5h://127.0.0.1:21071', runner: fakeRunner('89.127.232.37\n') });
  assert.equal(r.ok, true);
  assert.equal(r.exit_ip, '89.127.232.37');
  assert.equal(r.via, DEFAULT_PROBES[0]);
});

test('响应不是 IP（HTML/错误页）→ 视为失败，不许当出口', () => {
  const r = probeEgress({ endpoint: 'socks5h://127.0.0.1:21071', runner: fakeRunner('<html>oops</html>') });
  assert.equal(r.ok, false);
  assert.equal(r.exit_ip, null);
});

test('全部探测服务失败 → ok:false 且带原因', () => {
  const r = probeEgress({ endpoint: 'socks5h://127.0.0.1:9999', runner: fakeRunner('', 7) });
  assert.equal(r.ok, false);
  assert.match(r.error, /全部探测服务均失败/);
});

test('无端点 → 直接拒绝（不许在无出口时探测）', () => {
  const r = probeEgress({});
  assert.equal(r.ok, false);
  assert.match(r.error, /缺少出口端点/);
});

test('工具动作 probe：拿活跃路由现测并记录；无路由时明确报错', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-egress-probe-'));
  const svc = createWarroomService({ home, adapterKind: 'fake' });
  try {
    const eng = TOOLS.find((t) => t.name === 'warroom_engage').run(svc, { targets: ['t.example'], user_message_id: 'um' });
    const jumps = TOOLS.find((t) => t.name === 'warroom_jumps');
    const egress = TOOLS.find((t) => t.name === 'warroom_egress_check');

    // 还没有路由 → 明确拒绝
    assert.throws(() => egress.run(svc, { engagement_id: eng.engagement_id, action: 'probe' }), /没有活跃路由/);

    jumps.run(svc, { engagement_id: eng.engagement_id, action: 'import',
      hosts: [{ id: 'jh-x', ssh_host: 'socks5h://127.0.0.1:21071', addr_v4: '89.127.232.37' }] });
    const route = jumps.run(svc, { engagement_id: eng.engagement_id, action: 'acquire', target: 't.example' });
    assert.equal(route.socks_source, 'operator');

    // probe 会真起 curl；本机 21071 若活着就 pass（否则记 fail + 抛错）——两种都断言"如实"
    let result = null; let err = null;
    try { result = egress.run(svc, { engagement_id: eng.engagement_id, action: 'probe' }); } catch (e) { err = e; }
    if (result) {
      assert.equal(result.verdict, 'pass');
      assert.equal(result.measured, true);
      assert.match(String(result.exit_ip), /^[0-9a-fA-F:.]{6,45}$/);
      assert.equal(result.route_id, route.route_id);
    } else {
      assert.match(err.message, /出口现测失败（已记 fail）/);
      const st = egress.run(svc, { engagement_id: eng.engagement_id, action: 'status' });
      assert.equal(st.last?.verdict ?? st.last_verdict, 'fail', '失败必须如实入账');
    }
  } finally { svc.broker.global.close(); }
});
