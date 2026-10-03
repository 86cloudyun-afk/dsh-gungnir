// 出口现测：纪律是"测不出就是失败"——不得填历史值、不得假装通过；本机代理变量必须清掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeEgress, DEFAULT_PROBES } from '../packages/warroom-core/src/egress-probe.mjs';
import { TOOLS } from '../packages/warroom-tools/src/index.js';

const probeEnv = { HTTP_PROXY: 'http://proxy.example.test:8080', ALL_PROXY: 'socks5h://proxy.example.test:1080' };

const fakeRunner = (stdout, status = 0) => (args, { env }) => {
  assert.equal('HTTP_PROXY' in env, false, '必须清掉本机代理变量（否则静默回落本机出口）');
  assert.equal('ALL_PROXY' in env, false);
  assert.ok(args.includes('-x'), '必须显式带 -x 用 SOCKS 出口');
  return { status, stdout, stderr: status === 0 ? '' : 'boom' };
};

test('现测成功：返回实测 IP + 命中的探测服务', () => {
  const r = probeEgress({ endpoint: 'socks5h://proxy.example.test:1080', env: probeEnv, runner: fakeRunner('203.0.113.9\n') });
  assert.equal(r.ok, true);
  assert.equal(r.exit_ip, '203.0.113.9');
  assert.equal(r.via, DEFAULT_PROBES[0]);
});

test('响应不是 IP（HTML/错误页）→ 视为失败，不许当出口', () => {
  const r = probeEgress({ endpoint: 'socks5h://proxy.example.test:1080', env: probeEnv, runner: fakeRunner('<html>oops</html>') });
  assert.equal(r.ok, false);
  assert.equal(r.exit_ip, null);
});

test('全部探测服务失败 → ok:false 且带原因', () => {
  const r = probeEgress({ endpoint: 'socks5h://proxy.example.test:1081', env: probeEnv, runner: fakeRunner('', 7) });
  assert.equal(r.ok, false);
  assert.match(r.error, /全部探测服务均失败/);
});

test('无端点 → 直接拒绝（不许在无出口时探测）', () => {
  const r = probeEgress({});
  assert.equal(r.ok, false);
  assert.match(r.error, /缺少出口端点/);
});

test('模型 probe 在访问路由和调用探针前拒绝（不启动 curl）', () => {
  const accesses = [];
  const blocked = new Proxy({}, { get: (_, key) => { accesses.push(String(key)); throw new Error('unexpected host access'); } });
  const egress = TOOLS.find((t) => t.name === 'warroom_egress_check');
  assert.throws(() => egress.run(blocked, { engagement_id: 'eng_fixture', action: 'probe', route_id: 'route_fixture' }),
    /unsupported action/i);
  assert.deepEqual(accesses, []);
});
