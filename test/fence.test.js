// 桶 A 围栏：静态不变量 + 运行时验收的诚实语义（daemon 不可用 → SKIP，不假装通过）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFencePlan, verifyFencePlan, dockerCommands, runFenceVerification, FENCE_NETWORK } from '../packages/warroom-core/src/fence.js';

const basePlan = () => buildFencePlan({
  engagementId: 'eng_fence_test',
  route: { socks: 'socks5://127.0.0.1:2080', route_id: 'route-1' },
});

test('计划生成：internal 网络 + 任务容器只接内网 + DNS 不落宿主 + sidecar 双挂', () => {
  const plan = basePlan();
  assert.ok(plan.network.name.startsWith(FENCE_NETWORK));
  assert.equal(plan.network.internal, true);
  assert.deepEqual(plan.task.networks, [plan.network.name]);
  assert.deepEqual(plan.sidecar.networks, [plan.network.name, 'bridge']);
  assert.equal(plan.sidecar.upstream, 'socks5://127.0.0.1:2080');
  const v = verifyFencePlan(plan);
  assert.equal(v.ok, true, v.errors.join(';'));
  assert.ok(v.guarantees.length >= 4);
});

test('静态不变量 fail-closed：逐条破坏必须被拒', () => {
  const cases = [
    ['network 非 internal', (p) => { p.network.internal = false; }],
    ['任务容器多接一张网', (p) => { p.task.networks.push('bridge'); }],
    ['DNS 落公共解析器', (p) => { p.task.dns = ['8.8.8.8']; }],
    ['DNS 缺失（默认落宿主）', (p) => { p.task.dns = []; }],
    ['任务容器用 host 网络', (p) => { p.task.host_network = true; }],
    ['任务容器特权模式', (p) => { p.task.privileged = true; }],
    ['任务容器挂载 docker.sock', (p) => { p.task.mounts = ['/var/run/docker.sock:/var/run/docker.sock']; }],
    ['sidecar 未双挂', (p) => { p.sidecar.networks = [p.network.name]; }],
    ['sidecar 上游不是 socks', (p) => { p.sidecar.upstream = 'http://127.0.0.1:8080'; }],
  ];
  for (const [name, mutate] of cases) {
    const p = basePlan();
    mutate(p);
    const v = verifyFencePlan(p);
    assert.equal(v.ok, false, `应拒绝：${name}`);
    assert.ok(v.errors.length >= 1, `应给出错误：${name}`);
  }
});

test('docker 命令序列包含 --internal 与显式 --dns，且清理步骤在尾', () => {
  const cmds = dockerCommands(basePlan());
  assert.ok(cmds[0].includes('--internal'));
  assert.ok(cmds.some((c) => c.includes('--dns')));
  assert.ok(cmds.at(-1).join(' ').includes('network rm'));
  assert.ok(cmds.at(-2).join(' ').includes('rm -f'));
});

test('运行时验收：daemon 不可用 → SKIP（如实上报）', () => {
  const r = runFenceVerification({ plan: basePlan(), run: () => ({ ok: false, out: 'Cannot connect to the Docker daemon' }) });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /daemon/);
  assert.ok(r.steps.some((s) => s.skipped));
});

test('运行时验收：围栏生效 → passed；任务容器仍能直连出网 → failed', () => {
  const okRun = (args) => {
    const line = args.join(' ');
    if (line.includes('docker info')) return { ok: true, out: 'Server Version: 29' };
    if (line.includes('wget')) return { ok: true, out: 'EGRESS_BLOCKED' };
    return { ok: true, out: 'ok' };
  };
  assert.equal(runFenceVerification({ plan: basePlan(), run: okRun }).status, 'passed');

  const leakyRun = (args) => {
    const line = args.join(' ');
    if (line.includes('docker info')) return { ok: true, out: 'Server Version: 29' };
    if (line.includes('wget')) return { ok: true, out: '<html>example.com</html>' }; // 直连成功 = 围栏失效
    return { ok: true, out: 'ok' };
  };
  const r = runFenceVerification({ plan: basePlan(), run: leakyRun });
  assert.equal(r.status, 'failed');
  assert.ok(r.failed.some((f) => f.name.includes('阻断')));
});
