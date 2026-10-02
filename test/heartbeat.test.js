// 长时任务心跳：超时巡检以最近心跳为基准，正常长任务不被误判。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';

function ctx() {
  const home = mkdtempSync(join(tmpdir(), 'wr-hb-'));
  let now = Date.now();
  const broker = new Broker({ home, adapter: new FakeAdapter({ faults: { neverFinish: true } }), nowMs: () => now });
  const eng = broker.createEngagement({ user_message_id: 'um-hb', targets: ['10.0.0.0/24'], overrides: { rhythm: 'open' } });
  const contract = {
    targets: ['10.0.0.5'], action_class: 'active', resources: [], wire_cost: 0,
    fake_members: [{ entity_type: 'asset', source_id: 'hb-1', revision_no: 1, content_hash: 'h', payload: {} }],
  };
  return { home, broker, eng, contract, tick: (ms) => { now += ms; } };
}

test('心跳续命：超时阈值内不断心跳 → 不被清扫', () => {
  const c = ctx();
  const ex = c.broker.execute({ engagement_id: c.eng.engagement_id, auth_version: 1, action_class: 'active', command_id: 'hb-1', contract: c.contract });

  for (let i = 0; i < 3; i += 1) {
    c.tick(20 * 60 * 1000);                       // 每 20 分钟心跳一次（阈值 30 分钟）
    c.broker.heartbeat(c.eng.engagement_id, ex.task_id, { note: `progress ${i}` });
  }
  const swept = c.broker.sweepTimeouts(c.eng.engagement_id, { timeoutMs: 30 * 60 * 1000 });
  assert.equal(swept.swept.length, 0, '持续心跳的长任务不应被清扫');
  assert.equal(c.broker.status(c.eng.engagement_id, ex.task_id).ledger_state, 'running');
});

test('心跳失效：心跳后再无进展且超过阈值 → 转 unknown（标注基准为 heartbeat）', () => {
  const c = ctx();
  const ex = c.broker.execute({ engagement_id: c.eng.engagement_id, auth_version: 1, action_class: 'active', command_id: 'hb-2', contract: c.contract });
  c.tick(10 * 60 * 1000);
  c.broker.heartbeat(c.eng.engagement_id, ex.task_id);
  c.tick(31 * 60 * 1000);

  const swept = c.broker.sweepTimeouts(c.eng.engagement_id, { timeoutMs: 30 * 60 * 1000 });
  assert.equal(swept.swept.length, 1);
  assert.equal(swept.swept[0].since, 'heartbeat', '应标明基准是心跳而非派发时刻');
  assert.equal(c.broker.status(c.eng.engagement_id, ex.task_id).ledger_state, 'unknown');
});

test('未心跳的任务仍按派发时刻判定（since=dispatch）', () => {
  const c = ctx();
  c.broker.execute({ engagement_id: c.eng.engagement_id, auth_version: 1, action_class: 'active', command_id: 'hb-3', contract: c.contract });
  c.tick(31 * 60 * 1000);
  const swept = c.broker.sweepTimeouts(c.eng.engagement_id, { timeoutMs: 30 * 60 * 1000 });
  assert.equal(swept.swept[0].since, 'dispatch');
});

test('终态任务拒绝心跳；gate_log 留痕', () => {
  const c = ctx();
  const ex = c.broker.execute({ engagement_id: c.eng.engagement_id, auth_version: 1, action_class: 'active', command_id: 'hb-4', contract: c.contract });
  c.broker.cancel(c.eng.engagement_id, ex.task_id, 'test');
  assert.throws(() => c.broker.heartbeat(c.eng.engagement_id, ex.task_id), (e) => e.code === 'E_INVALID_TRANSITION');

  const c2 = ctx();
  const ex2 = c2.broker.execute({ engagement_id: c2.eng.engagement_id, auth_version: 1, action_class: 'active', command_id: 'hb-5', contract: c2.contract });
  c2.broker.heartbeat(c2.eng.engagement_id, ex2.task_id, { note: 'db dump 40%' });
  const row = c2.broker._eng(c2.eng.engagement_id).store.db
    .prepare("SELECT detail FROM gate_log WHERE decision = 'heartbeat'").get();
  assert.match(row.detail, /db dump 40%/);
});

test('CLI heartbeat 可用', () => {
  const c = ctx();
  const ex = c.broker.execute({ engagement_id: c.eng.engagement_id, auth_version: 1, action_class: 'active', command_id: 'hb-6', contract: c.contract });
  const out = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'heartbeat',
    '--engagement', c.eng.engagement_id, '--task', ex.task_id, '--note', 'cli', '--home', c.home, '--json'],
  { encoding: 'utf8', env: { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' } }));
  assert.equal(out.task_id, ex.task_id);
  assert.equal(out.ledger_state, 'running');
});
