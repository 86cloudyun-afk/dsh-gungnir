// 巡检统一视图：汇聚路由/任务/出口/壳 + 告警；只读、不改任何状态。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { harness } from '../packages/warroom-core/src/testing.js';
import { renderWatch } from '../packages/warroom-core/src/watch.js';
import { JumphostManager } from '../packages/warroom-core/src/jumphosts.js';

const mk = (h, opts = {}) => new JumphostManager({
  globalDb: h.broker.global, getFactStore: (id) => h.broker._eng(id).store,
  listEngagements: () => h.broker.listEngagements(), ...opts,
});

test('空战役：无活跃路由 + 无在飞任务，告警提示取出口', () => {
  const h = harness();
  const v = h.broker.watch(h.eng.engagement_id);
  assert.equal(v.routes.active.length, 0);
  assert.equal(v.tasks.in_flight.length, 0);
  assert.ok(v.warnings.some((w) => w.includes('没有活跃跳板路由')));
  assert.ok(v.egress && 'valid' in v.egress);
});

test('在飞任务与失效路由同时出现：两条告警都在，且任务带心跳龄期', () => {
  const h = harness({ faults: { neverFinish: true } });
  const ex = h.broker.execute({ ...h.base, command_id: 'w-1', contract: h.contract() });
  h.broker.heartbeat(h.eng.engagement_id, ex.task_id, { note: '进度 30%' });

  const jm = mk(h, { ttlMinutes: 1 });
  jm.importHosts([{ id: 'w-jh', addr_v4: '203.0.113.80' }]);
  const acq = jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });
  jm.release(acq.lease_id);            // 制造"路由失效"
  jm.sweepRoutes();

  const v = h.broker.watch(h.eng.engagement_id);
  assert.equal(v.routes.stale.length, 1);
  assert.equal(v.tasks.in_flight.length, 1);
  assert.equal(v.tasks.in_flight[0].since, 'heartbeat', '应表明龄期基准');
  assert.equal(v.tasks.in_flight[0].overdue, false);
  assert.ok(v.warnings.some((w) => w.includes('失效')), JSON.stringify(v.warnings));
  assert.ok(v.warnings.some((w) => w.includes('没有活跃跳板路由')));

  const text = renderWatch(v);
  assert.match(text, /巡检视图：eng_/);
  assert.match(text, /\[失效\]/);
  assert.match(text, /\[在飞\]/);
});

test('超阈值任务被标 overdue 并告警；unresolved 单独提示', () => {
  const h = harness({ faults: { neverFinish: true } });
  const ex = h.broker.execute({ ...h.base, command_id: 'w-2', contract: h.contract() });
  // 把派发时间推早 2 小时（阈值 30 分钟）
  h.broker.global.prepare('UPDATE command_queue SET ts = ? WHERE task_id = ?')
    .run(new Date(Date.now() - 2 * 3600_000).toISOString(), ex.task_id);

  const v = h.broker.watch(h.eng.engagement_id, { timeoutMin: 30 });
  assert.equal(v.tasks.in_flight[0].overdue, true);
  assert.ok(v.warnings.some((w) => w.includes('超过超时阈值')));
});

test('只读：巡检不产生任何写入（水位与命令状态不变）', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'w-3', contract: h.contract() });
  const seqBefore = h.store().seq();
  const stateBefore = h.broker.global.prepare('SELECT state FROM command_queue WHERE task_id = ?').get(ex.task_id).state;

  h.broker.watch(h.eng.engagement_id);
  h.broker.watch(h.eng.engagement_id);

  assert.equal(h.store().seq(), seqBefore, '巡检不得改动水位');
  assert.equal(h.broker.global.prepare('SELECT state FROM command_queue WHERE task_id = ?').get(ex.task_id).state, stateBefore);
});

test('CLI watch 文本与 JSON 双路可用', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  const text = execFileSync('node', ['bin/warroom.mjs', 'watch', '--engagement', h.eng.engagement_id, '--home', h.home, '--text'],
    { encoding: 'utf8', env });
  assert.match(text, /巡检视图/);
  assert.match(text, /需要注意：/);
  const parsed = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'watch', '--engagement', h.eng.engagement_id, '--home', h.home, '--json'],
    { encoding: 'utf8', env }));
  assert.ok(Array.isArray(parsed.warnings));
});
