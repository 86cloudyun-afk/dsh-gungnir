// schema 版本 / 迁移幂等 / 高版本拒绝 / 备份一致性（框架 §10）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { harness } from '../packages/warroom-core/src/testing.js';
import { openEngagementDb, openGlobalDb } from '../packages/warroom-core/src/db.js';
import { runMigrations, ERR_SCHEMA_NEWER } from '../packages/warroom-core/src/migrate.js';

test('迁移幂等：重复打开版本不变、无异常', () => {
  const h = harness();
  const dir = join(h.home, 'engagements', h.eng.engagement_id);
  const db2 = openEngagementDb(dir);
  assert.equal(db2.prepare("SELECT v FROM meta WHERE k = 'schema_version:fact'").get().v, '6');
  db2.close();
  const db3 = openEngagementDb(dir);
  assert.equal(db3.prepare("SELECT v FROM meta WHERE k = 'schema_version:fact'").get().v, '6');
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
  // 库数量随功能增长（global.db + fact.db + knowledge.db）：断言"全部成功"而非写死数字
  const m = out.match(/备份完成 (\d+)\/(\d+)/);
  assert.ok(m, '应打印备份计数');
  assert.equal(m[1], m[2], '所有库都必须备份成功');
  assert.ok(Number(m[1]) >= 2, '至少 global.db 与 fact.db');
  assert.match(out, /knowledge\.db \(integrity ok\)|global\.db \(integrity ok\)/);

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

test('v2 迁移：老库缺 secret 表时补建（global 库专属迁移）', async () => {
  const h = harness();
  const g = h.broker.global;
  g.exec('DROP TABLE IF EXISTS secret_store; DROP TABLE IF EXISTS secret_grants;');
  g.prepare("UPDATE meta SET v = '1' WHERE k = 'schema_version:global'").run();
  // 重新打开触发迁移
  const reopened = openGlobalDb(h.home);
  const v = reopened.prepare("SELECT v FROM meta WHERE k = 'schema_version:global'").get().v;
  assert.equal(v, '8', 'global 库目标版本（v8 为其最新迁移）');
  const tables = reopened.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes('secret_store') && tables.includes('secret_grants') && tables.includes('approvals'));
  // fact 库不应被 global 专属迁移污染
  const factTables = h.store().db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.equal(factTables.includes('secret_store'), false);
});

test('runMigrations 返回值：已迁移库 from=to=当前版本', () => {
  const h = harness();
  const dir = join(h.home, 'engagements', h.eng.engagement_id);
  const db = openEngagementDb(dir);
  const r = runMigrations(db, 'fact');
  assert.equal(r.from, 6);
  assert.equal(r.to, 6);
  assert.equal(r.applied.length, 0);
  db.close();
});
