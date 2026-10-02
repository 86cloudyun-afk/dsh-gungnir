// 故障矩阵 + 再水化的回归（框架 §10）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFaultMatrix, SCENARIOS } from '../packages/warroom-core/src/testing/faults.js';
import { execFileSync } from 'node:child_process';
import { rehydrate, OPEN_STATES } from '../packages/warroom-core/src/rehydrate.js';
import { harness } from '../packages/warroom-core/src/testing.js';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';

test('故障注入矩阵全绿（21 场景：故障 + 持久层 + 交付边界 + 门禁 + 确认边界 + 归档幂等 + 门禁同源）', () => {
  const r = runFaultMatrix();
  assert.equal(r.failed.length, 0, r.failed.map((f) => `${f.name}: ${f.detail}`).join('\n'));
  assert.ok(r.total >= 21, `场景数应 ≥21，实际 ${r.total}`);
});

test('再水化：只恢复非终态命令，终态不重建', () => {
  const h = harness();
  const a = h.broker.execute({ ...h.base, command_id: 'rh-1', contract: h.contract() });
  const b = h.broker.execute({ ...h.base, command_id: 'rh-2', contract: h.contract() });
  h.broker.cancel(h.eng.engagement_id, a.task_id, 'test');   // → confirmed_stopped（终态）
  const broker2 = new Broker({ home: h.home, adapter: new FakeAdapter() });
  const { hydrated } = rehydrate(broker2);
  assert.equal(hydrated, 1, '只有运行中的 b 应被重建');
  assert.ok(!broker2.adapter.tasks.has('rh-1'));
  assert.ok(broker2.adapter.tasks.has('rh-2'));
  assert.deepEqual([...OPEN_STATES].includes('confirmed_stopped'), false);
});

test('场景清单与实现同源：逐字一致（清单漂移即失败）', () => {
  const r = runFaultMatrix();
  const implemented = r.checks.map((c) => c.name);
  const declared = SCENARIOS.map((s) => s.name);
  assert.deepEqual(declared, implemented,
    'SCENARIOS 清单必须与实现中的 check(...) 名称逐字一致（顺序也一致）');
  assert.equal(SCENARIOS.length, 21);
  assert.ok(SCENARIOS.every((s) => s.expects && s.contract), '每条场景都要有期望与契约归属');
});

test('--describe 输出四列（序号/场景/期望/契约）', () => {
  const out = execFileSync('node', ['scripts/fault-matrix.mjs', '--describe'], { encoding: 'utf8' });
  const rows = out.trim().split('\n').filter((l) => l.trim() && !l.startsWith('('));
  assert.equal(rows.length, 21);
  const cols = rows[0].split('\t');
  assert.equal(cols.length, 4);
  assert.equal(cols[0], '1');
  assert.match(cols[3], /ADR-|框架/);
});
