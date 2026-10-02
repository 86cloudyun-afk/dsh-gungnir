// stealth 档节奏：抖动区间 + 每小时漂移（框架 §4），可确定性测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';
import { RHYTHM_JITTER_MS } from '../packages/shared-types/src/index.js';

function ctx({ rng = () => 1, now } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wr-jitter-'));
  // 基线必须贴近真实时间：rate_ledger 的时间戳由 store 用真实时钟写入，
  // 注入时钟若偏离太远会让"间隔"失去意义（这是测试装置问题，不是门闸问题）。
  let t = now ?? Date.now();
  const broker = new Broker({ home, adapter: new FakeAdapter(), nowMs: () => t, rng });
  const eng = broker.createEngagement({
    user_message_id: 'um-jit', targets: ['10.0.0.0/24'], overrides: { rhythm: 'stealth' },
  });
  return { home, broker, eng, setNow: (v) => { t = v; }, advance: (ms) => { t += ms; } };
}

test('抖动：rng=1 → 取区间上界（25s）；rng=0 → 取地板（8s）', () => {
  const [lo, hi] = RHYTHM_JITTER_MS.stealth;
  const high = ctx({ rng: () => 1 });
  const low = ctx({ rng: () => 0 });
  // 漂移会让绝对值有 ±20% 浮动，但相对关系必须成立：上界 > 下界
  const gapHigh = high.broker._requiredGap('stealth');
  const gapLow = low.broker._requiredGap('stealth');
  assert.ok(gapHigh > gapLow, `上界(${gapHigh}) 应大于地板(${gapLow})`);
  assert.ok(gapLow >= lo * (1 - 0.2), '漂移不得低于基础地板（含 ±20% 容差）');
  assert.ok(gapHigh <= hi * (1 + 0.2), '漂移不得超过上界 +20%');
});

test('漂移：同一小时内稳定，跨小时变化', () => {
  const c = ctx({ rng: () => 0.5 });
  const t0 = Date.now();
  c.setNow(t0);
  const a = c.broker._requiredGap('stealth');
  c.advance(30 * 60 * 1000);            // 仍在同一小时
  const b = c.broker._requiredGap('stealth');
  assert.equal(a, b, '同一小时内应稳定（否则退化为纯随机）');
  c.advance(40 * 60 * 1000);            // 跨到下一小时
  const d = c.broker._requiredGap('stealth');
  assert.notEqual(a, d, '跨小时应发生漂移');
});

test('open/restricted 不受抖动影响（仍为 0 间隔）', () => {
  const c = ctx({ rng: () => 0.9 });
  assert.equal(c.broker._requiredGap('open'), 0);
  assert.equal(c.broker._requiredGap('restricted'), 0);
});

test('门闸生效：stealth 档两次出网需满足本次要求间隔（含 retry_after_ms 提示）', () => {
  const c = ctx({ rng: () => 0 });   // 取地板
  const contract = (over = {}) => ({
    targets: ['10.0.0.5'], action_class: 'active', resources: [], wire_cost: 1,
    fake_members: [{ entity_type: 'asset', source_id: 'sj-1', revision_no: 1, content_hash: 'h', payload: {} }], ...over,
  });
  const base = { engagement_id: c.eng.engagement_id, auth_version: 1 };
  c.broker.execute({ ...base, command_id: 'sj-1', contract: contract() });
  c.broker.cancel(c.eng.engagement_id, 'sj-1', 'test');   // 释放并发（stealth 并发=1）

  let err = null;
  try {
    c.broker.execute({ ...base, command_id: 'sj-2', contract: contract() });
  } catch (e) { err = e; }
  assert.equal(err?.code, 'E_GATE_RATE_LIMIT');
  assert.ok(err.retry_after_ms > 0, '应给出 retry_after_ms');

  c.setNow(c.broker._nowMs() + err.retry_after_ms + 50);
  const ok = c.broker.execute({ ...base, command_id: 'sj-2', contract: contract() });
  assert.equal(ok.state, 'running');
});
