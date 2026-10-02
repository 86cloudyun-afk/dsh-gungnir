// 备份保留策略与恢复演练/落地。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from '../packages/warroom-core/src/testing.js';
import { backupHome, restoreHome } from '../packages/warroom-core/src/maintenance.js';

test('保留策略：--keep N 只保留最近 N 份自动备份（手工 dest 不受影响）', () => {
  const h = harness();
  const manual = join(h.home, 'manual-backup');
  const b0 = backupHome({ home: h.home, dest: manual });
  assert.equal(b0.pruned.length, 0, '手工 dest 不参与轮转');

  // 造 4 份自动备份（同秒内 mtime 可能相同 → 分目录名固定，便于断言数量）
  for (let i = 0; i < 4; i += 1) {
    backupHome({ home: h.home, dest: join(h.home, 'backups', `auto-${i}`) });
  }
  // 用 keep=2 触发轮转（dest=null 时才对 backups/ 生效）
  const r = backupHome({ home: h.home, keep: 2 });
  const remaining = readdirSync(join(h.home, 'backups')).sort();
  assert.ok(remaining.length <= 2, `自动备份应保留 ≤2 份，实际 ${remaining.join(',')}`);
  assert.ok(existsSync(manual), '手工备份必须保留');
  void r;
});

test('恢复演练（默认 dry-run）：给计划与校验，不改动数据', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'rs-1', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  const bk = backupHome({ home: h.home, dest: join(h.home, 'bk-for-restore') });

  // 备份后篡改
  h.store().db.exec('DELETE FROM fact_members');
  const before = h.store().effectiveCount();

  const dry = restoreHome({ home: h.home, from: bk.dest, dryRun: true });
  assert.equal(dry.applied, false);
  assert.ok(dry.plan.length >= 2);
  assert.ok(dry.plan.every((p) => p.verdict === 'ok'));
  assert.equal(h.store().effectiveCount(), before, 'dry-run 不得改动数据');
});

test('恢复落地：--apply 先做恢复前快照，再逐库覆盖', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'rs-2', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  const bk = backupHome({ home: h.home, dest: join(h.home, 'bk-apply') });

  h.broker._eng(h.eng.engagement_id).db.close();
  const applied = restoreHome({ home: h.home, from: bk.dest, dryRun: false, broker: h.broker });
  assert.equal(applied.applied, true);
  assert.ok(applied.safety_backup && existsSync(applied.safety_backup), '必须有恢复前快照');
  assert.ok(applied.warnings.some((w) => w.includes('重启')), '应提示重启宿主进程');
});

test('CLI backup --keep 与 restore --from 可用', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  const cli = (args) => JSON.parse(execFileSync('node', ['bin/warroom.mjs', ...args, '--home', h.home, '--json'], { encoding: 'utf8', env }));

  const bk = cli(['backup', '--keep', '1']);
  assert.ok(bk.dest);
  const dry = cli(['restore', '--from', bk.dest]);
  assert.equal(dry.applied, false);
  assert.ok(dry.plan.length >= 1);
});

test('损坏备份被识别：完整性异常进警告且非零退出', () => {
  const h = harness();
  const bk = backupHome({ home: h.home, dest: join(h.home, 'bk-broken') });
  const rel = 'global.db';
  writeFileSync(join(bk.dest, rel), 'not a sqlite file');
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  let code = 0;
  try {
    execFileSync('node', ['bin/warroom.mjs', 'restore', '--from', bk.dest, '--home', h.home, '--json'], { encoding: 'utf8', env, stdio: 'pipe' });
  } catch (e) { code = e.status; }
  assert.notEqual(code, 0, '备份损坏时应非零退出');
});
