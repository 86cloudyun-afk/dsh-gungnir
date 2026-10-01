// 一致性套件：FakeAdapter 与 RedteamModeAdapter 都必须全绿；坏 adapter 必须有齿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';
import { RedteamModeAdapter, LocalRedteamDriver } from '../packages/warroom-core/src/adapters/redteam-mode.js';
import { runConformance, summarize } from '../packages/warroom-core/src/adapters/conformance.js';

test('FakeAdapter 通过全部契约检查', () => {
  const results = runConformance(new FakeAdapter(), { commandIdPrefix: 'fake' });
  const s = summarize(results);
  assert.equal(s.failed.length, 0, s.failed.join('\n'));
  assert.ok(s.total >= 8, `检查项过少: ${s.total}`);
});

test('RedteamModeAdapter（LocalDriver）通过全部契约检查，且角色映射生效', () => {
  const adapter = new RedteamModeAdapter({
    driver: new LocalRedteamDriver(),
    roleByIntent: { recon: 'recon', exploit: 'exploit' },
  });
  const results = runConformance(adapter, { commandIdPrefix: 'rt' });
  const s = summarize(results);
  assert.equal(s.failed.length, 0, s.failed.join('\n'));

  const r = adapter.dispatch('role-check', {
    targets: ['10.0.0.5'], action_class: 'readonly', task_id: 't-role', generation: '1:1:1',
    intent: 'exploit', resources: [],
  });
  assert.equal(adapter.status(r.task_id).role, 'exploit');
});

test('套件有齿：故意残缺的 adapter 必须被检出多项失败', () => {
  const broken = {
    dispatch: () => ({ task_id: 'x' }),
    lookup: () => null,
    status: () => ({ notState: true }),
    manifestOf: () => [{ id: 'a' }],            // 缺 kind/check
    cancel: () => { throw new Error('no cancel'); },
    collect: () => ({ generation: '1:1:1' }),   // 缺 receipt_id/members
    reconcile: () => ({ state: 'weird' }),      // 非终态
  };
  const s = summarize(runConformance(broken, { commandIdPrefix: 'broken' }));
  assert.ok(s.failed.length >= 5, `应检出多项失败，实际 ${s.failed.length}`);
});
