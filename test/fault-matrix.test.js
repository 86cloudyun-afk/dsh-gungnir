// 故障矩阵 + 再水化的回归（框架 §10）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFaultMatrix } from '../packages/warroom-core/src/testing/faults.js';
import { rehydrate, OPEN_STATES } from '../packages/warroom-core/src/rehydrate.js';
import { harness } from '../packages/warroom-core/src/testing.js';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';

test('故障注入矩阵全绿（11 场景：故障 + 持久层韧性）', () => {
  const r = runFaultMatrix();
  assert.equal(r.failed.length, 0, r.failed.map((f) => `${f.name}: ${f.detail}`).join('\n'));
  assert.ok(r.total >= 11, `场景数应 ≥11，实际 ${r.total}`);
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
