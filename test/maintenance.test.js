// 备份/维护 API 与 CLI：一致性、可重复、WAL 检查点、doctor 备份新鲜度。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from '../packages/warroom-core/src/testing.js';
import { backupHome, latestBackup, checkpointHome } from '../packages/warroom-core/src/maintenance.js';

test('备份 API：全库快照 + 完整性 + 可重复执行', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'bk-1', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  h.broker.knowledge.addPoc({ code: 'BK-1', title: '备份用例', category: 'other' });

  const r1 = backupHome({ home: h.home });
  assert.equal(r1.ok, r1.total);
  assert.ok(r1.total >= 3, `应至少备份 global/fact/knowledge 三库，实际 ${r1.total}`);
  assert.ok(r1.items.every((i) => i.verdict === 'ok'));

  const r2 = backupHome({ home: h.home, dest: r1.dest });  // 重复到同一目录
  assert.equal(r2.ok, r2.total, '重复备份必须可执行（VACUUM INTO 目标已存在也应处理）');
});

test('latestBackup：返回最近一次备份目录时间', () => {
  const h = harness();
  assert.equal(latestBackup({ home: h.home }), null);
  backupHome({ home: h.home });
  const latest = latestBackup({ home: h.home });
  assert.ok(latest && latest.mtime > 0);
});

test('checkpoint：WAL 截断 + 完整性自检', () => {
  const h = harness();
  h.broker.execute({ ...h.base, command_id: 'cp-1', contract: h.contract() });
  const rows = checkpointHome({ home: h.home });
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((r) => r.integrity === 'ok' && r.checkpoint === 'ok'));
});

test('CLI backup / maintain 可用（backup 后 doctor 显示备份新鲜度）', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  const bk = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'backup', '--home', h.home, '--json'], { encoding: 'utf8', env }));
  assert.equal(bk.ok, bk.total);
  assert.ok(existsSync(bk.dest));

  const mt = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'maintain', '--home', h.home, '--json'], { encoding: 'utf8', env }));
  assert.equal(mt.ok, true);

  const doc = JSON.parse(execFileSync('node', ['scripts/doctor.mjs', '--home', h.home, '--json'], { encoding: 'utf8', env }));
  const backupCheck = doc.checks.find((c) => c.name.startsWith('最近备份'));
  assert.ok(backupCheck, 'doctor 应有备份新鲜度检查');
  assert.equal(backupCheck.status, 'ok', '刚备份过应为 ok');
});
