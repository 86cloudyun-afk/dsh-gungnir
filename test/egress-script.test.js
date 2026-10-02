// 出口验证脚本：离线补录 / 期望不匹配 / SKIP 语义 / doctor 配置检查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from '../packages/warroom-core/src/testing.js';

// stdout 与 stderr 必须分开：Node 的实验性警告会混进 stderr，拼接会破坏 JSON 解析
const run = (args, env = {}) => {
  try {
    const out = execFileSync('node', ['scripts/egress-check.mjs', ...args],
      { encoding: 'utf8', env: { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out, err: '' };
  } catch (e) { return { code: e.status, out: e.stdout ?? '', err: e.stderr ?? '' }; }
};

test('离线补录：--observed 与 --expect 一致 → pass 且入账', () => {
  const h = harness();
  const r = run(['--home', h.home, '--engagement', h.eng.engagement_id,
    '--observed', '203.0.113.5', '--expect', '203.0.113.5', '--json']);
  assert.equal(r.code, 0, r.out);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.status, 'passed');
  assert.equal(h.broker.egressStatus(h.eng.engagement_id).valid, true);
});

test('不匹配 → 非零退出 + verdict=fail 入账', () => {
  const h = harness();
  const r = run(['--home', h.home, '--engagement', h.eng.engagement_id,
    '--observed', '198.51.100.7', '--expect', '203.0.113.5', '--json']);
  assert.equal(r.code, 1);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.status, 'mismatch');
  assert.equal(h.broker.egressStatus(h.eng.engagement_id).valid, false);
});

test('无 route 且非 --self → 明确失败（不编造出口）', () => {
  const h = harness();
  const r = run(['--home', h.home, '--engagement', h.eng.engagement_id]);
  // 退出码语义：0=通过 / 1=不匹配 / 2=用法或前置缺失 / 3=SKIP（环境不可用，非通过）
  assert.equal(r.code, 2, `无活跃 route 属前置缺失，应为 2，实际 ${r.code}（${r.err}）`);
  assert.match(r.out + r.err, /没有活跃跳板路由/);
});

test('--self 模式在代理环境变量存在时拒绝（宪法 §12 禁止二级代理）', () => {
  const h = harness();
  const r = run(['--home', h.home, '--engagement', h.eng.engagement_id, '--self'], { http_proxy: 'http://127.0.0.1:9999' });
  assert.equal(r.code, 2);
  assert.match(r.out + r.err, /代理环境变量/);
});

test('doctor：强制出口验证但无有效记录 → warn', () => {
  const h = harness();
  writeFileSync(join(h.home, 'warroom.json'), JSON.stringify({ requireEgressCheck: true, egressMaxAgeMin: 30 }));
  const out = execFileSync('node', ['scripts/doctor.mjs', '--home', h.home, '--json'],
    { encoding: 'utf8', env: { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' } });
  const parsed = JSON.parse(out);
  const check = parsed.checks.find((c) => c.name === '出口验证门闸');
  assert.ok(check);
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /无有效期内的 pass/);
});
