// schema 版本 / 迁移幂等 / 高版本拒绝 / 备份一致性（框架 §10）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { harness } from '../packages/warroom-core/src/testing.js';
import { openEngagementDb } from '../packages/warroom-core/src/db.js';
import { runMigrations, ERR_SCHEMA_NEWER } from '../packages/warroom-core/src/migrate.js';

test('迁移幂等：重复打开版本不变、无异常', () => {
  const h = harness();
  const dir = join(h.home, 'engagements', h.eng.engagement_id);
  const db2 = openEngagementDb(dir);
  assert.equal(db2.prepare("SELECT v FROM meta WHERE k = 'schema_version:fact'").get().v, '1');
  db2.close();
  const db3 = openEngagementDb(dir);
  assert.equal(db3.prepare("SELECT v FROM meta WHERE k = 'schema_version:fact'").get().v, '1');
  db3.close();
});

test('库版本高于代码版本 → 拒绝打开（不静默降级）', () => {
  const h = harness();
  const dir = join(h.home, 'engagements', h.eng.engagement_id);
  const db = new DatabaseSync(join(dir, 'fact.db'));
  db.prepare("UPDATE meta SET v = '999' WHERE k = 'schema_version:fact'").run();
  db.close();
  assert.throws(() => openEngagementDb(dir), (e) => e.code === ERR_SCHEMA_NEWER);
});

test('备份：一致性快照 + 完整性校验 + 行数对账', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'bk-1', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));

  const dest = join(h.home, 'test-backups');
  const out = execFileSync('node', ['scripts/backup.mjs', h.home, dest], { encoding: 'utf8' });
  assert.match(out, /integrity ok/);
  assert.match(out, /备份完成 2\/2/);

  const factBak = join(dest, 'engagements', h.eng.engagement_id, 'fact.db');
  const globalBak = join(dest, 'global.db');
  assert.ok(existsSync(factBak) && existsSync(globalBak));

  const orig = new DatabaseSync(join(h.home, 'engagements', h.eng.engagement_id, 'fact.db'));
  const bak = new DatabaseSync(factBak);
  const c1 = orig.prepare('SELECT COUNT(*) c FROM fact_members').get().c;
  const c2 = bak.prepare('SELECT COUNT(*) c FROM fact_members').get().c;
  assert.equal(c1, c2);
  assert.ok(c2 > 0);
  orig.close(); bak.close();
});

test('备份目标目录被自动创建且可重复执行', () => {
  const h = harness();
  const dest = join(h.home, 'bk-again');
  execFileSync('node', ['scripts/backup.mjs', h.home, dest], { encoding: 'utf8' });
  execFileSync('node', ['scripts/backup.mjs', h.home, dest], { encoding: 'utf8' });
  assert.ok(readdirSync(dest).includes('global.db'));
});

test('runMigrations 返回值：新库 from=null，老库 from=1', () => {
  const h = harness();
  const dir = join(h.home, 'engagements', h.eng.engagement_id);
  const db = openEngagementDb(dir);
  const r = runMigrations(db, 'fact');
  assert.equal(r.from, 1);
  assert.equal(r.to, 1);
  db.close();
});
