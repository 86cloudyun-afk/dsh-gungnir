// 速率与预算视图：用量/剩余/间隔（含抖动）/喷洒台账；只读。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { harness } from '../packages/warroom-core/src/testing.js';
import { renderRateView } from '../packages/warroom-core/src/rate-view.js';

test('wire 用量与预算：open 档有上限，用量按目标分布', () => {
  const h = harness({ authOverrides: { rhythm: 'open' } });
  const ex = h.broker.execute({ ...h.base, command_id: 'rv-1', contract: h.contract({ wire_cost: 12 }) });
  h.broker.settle(h.eng.engagement_id, ex.task_id);

  const v = h.broker.rateView(h.eng.engagement_id);
  assert.equal(v.rhythm, 'open');
  assert.equal(v.wire.used, 12);
  assert.equal(v.wire.cap, 100000);
  assert.equal(v.wire.remaining, 100000 - 12);
  assert.equal(v.wire.by_target.length, 1);
  assert.equal(v.wire.by_target[0].target, '10.0.0.5');
  assert.equal(v.wire.by_target[0].requests, 1);
  assert.match(v.policy, /硬门闸/);
});

test('stealth 档：给出抖动区间与"还需等待"（按当前要求间隔）', () => {
  const h = harness({ authOverrides: { rhythm: 'stealth' }, rng: () => 0 });
  h.broker.execute({ ...h.base, command_id: 'rv-2', contract: h.contract({ wire_cost: 1 }) });
  const v = h.broker.rateView(h.eng.engagement_id);
  assert.equal(v.rhythm, 'stealth');
  assert.deepEqual(v.pacing.jitter, [8000, 25000]);
  assert.ok(v.pacing.min_interval_ms >= 8000, `要求间隔应 ≥ 地板，实际 ${v.pacing.min_interval_ms}`);
  assert.ok(v.pacing.next_allowed_in_ms > 0, '刚出网后必须等待');
  assert.equal(v.concurrency.cap, 1);

  const text = renderRateView(v);
  assert.match(text, /抖动区间 8000~25000ms/);
  assert.match(text, /还需等待/);
});

test('喷洒台账概况：计数与锁定提示', () => {
  const h = harness();
  h.broker.sprayApply(h.eng.engagement_id, [
    { credential_ref: 's1', service: 'ssh', account: 'root', result: 'fail' },
    { credential_ref: 's1', service: 'rdp', account: 'root', result: 'locked' },
  ]);
  const v = h.broker.rateView(h.eng.engagement_id);
  assert.equal(v.spray.total, 2);
  assert.equal(v.spray.locked, 1);
  const text = renderRateView(v);
  assert.match(text, /已锁定 1 次/);
});

test('只读：视图不写入任何账本', () => {
  const h = harness();
  const before = h.store().seq();
  const rowsBefore = h.store().db.prepare('SELECT COUNT(*) c FROM rate_ledger').get().c;
  h.broker.rateView(h.eng.engagement_id);
  assert.equal(h.store().seq(), before);
  assert.equal(h.store().db.prepare('SELECT COUNT(*) c FROM rate_ledger').get().c, rowsBefore);
});

test('CLI rate 文本与 JSON 双路可用', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  const text = execFileSync('node', ['bin/warroom.mjs', 'rate', '--engagement', h.eng.engagement_id, '--home', h.home, '--text'],
    { encoding: 'utf8', env });
  assert.match(text, /速率与预算：eng_/);
  const parsed = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'rate', '--engagement', h.eng.engagement_id, '--home', h.home, '--json'],
    { encoding: 'utf8', env }));
  assert.ok('wire' in parsed && 'pacing' in parsed && 'spray' in parsed);
});
