// 喷洒矩阵：断点/锁定过滤、locked 扩散防护、批量登记。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../packages/warroom-core/src/testing.js';

test('矩阵展开：3 凭据 × 2 服务 = 6 格，初始全部可跑', () => {
  const h = harness();
  const m = h.broker.sprayMatrix(h.eng.engagement_id, {
    credentials: ['sec_1', 'sec_2', 'sec_3'], services: ['ssh', 'rdp'], accounts: ['root'],
  });
  assert.equal(m.summary.cells, 6);
  assert.equal(m.summary.run, 6);
  assert.equal(m.ready.length, 6);
});

test('断点与锁定过滤：已试过 → skip-tried；锁定 → skip-locked（且不再出现在 ready）', () => {
  const h = harness();
  const args = { credentials: ['sec_1'], services: ['ssh', 'rdp'], accounts: ['root'] };
  h.broker.sprayApply(h.eng.engagement_id, [{ credential_ref: 'sec_1', service: 'ssh', account: 'root', result: 'fail' }]);
  h.broker.sprayApply(h.eng.engagement_id, [{ credential_ref: 'sec_1', service: 'rdp', account: 'root', result: 'locked' }]);

  const m = h.broker.sprayMatrix(h.eng.engagement_id, args);
  assert.equal(m.summary.skip_tried, 1);
  assert.equal(m.summary.skip_locked, 1);
  assert.equal(m.summary.run, 0, '两个格子都不该再跑');
  assert.equal(m.ready.length, 0);
});

test('locked 扩散防护：同一账号在别的服务上也应被拦（防锁死）', () => {
  const h = harness();
  const args = { credentials: ['sec_1', 'sec_2'], services: ['ssh', 'rdp'], accounts: ['root'] };
  h.broker.sprayApply(h.eng.engagement_id, [{ credential_ref: 'sec_1', service: 'rdp', account: 'root', result: 'locked' }]);
  const m = h.broker.sprayMatrix(h.eng.engagement_id, args);
  // rdp 服务上所有凭据都被 skip-locked（该服务×账号已锁定）
  const rdpCells = m.cells.filter((c) => c.service === 'rdp');
  assert.ok(rdpCells.every((c) => c.action === 'skip-locked'));
  // ssh 仍可跑
  assert.equal(m.cells.filter((c) => c.service === 'ssh' && c.action === 'run').length, 2);
});

test('批量登记：重复结果被跳过（already-tried），锁定结果切断后续', () => {
  const h = harness();
  const r1 = h.broker.sprayApply(h.eng.engagement_id, [
    { credential_ref: 'sec_1', service: 'ssh', account: 'root', result: 'fail' },
    { credential_ref: 'sec_1', service: 'ssh', account: 'root', result: 'fail' }, // 同格重复
    { credential_ref: 'sec_1', service: 'smb', account: 'root', result: 'locked' },
  ]);
  assert.equal(r1.summary.applied, 2);
  assert.equal(r1.skipped.length, 1);
  assert.equal(r1.skipped[0].reason, 'already-tried');

  const r2 = h.broker.sprayApply(h.eng.engagement_id, [
    { credential_ref: 'sec_2', service: 'smb', account: 'root', result: 'fail' }, // 该服务×账号已锁定
  ]);
  assert.equal(r2.summary.applied, 0);
  assert.equal(r2.skipped[0].reason, 'locked');
});
