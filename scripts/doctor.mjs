#!/usr/bin/env node
// warroom doctor：一键体检（环境 / 数据 / 秘密 / 闸门）。
// 用法：node scripts/doctor.mjs [--home <warroom-home>] [--json]
import { existsSync, statSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, targetVersionFor } from '../packages/warroom-core/src/migrate.js';
import { latestBackup } from '../packages/warroom-core/src/maintenance.js';
import { SCHEMA_VERSION } from '../packages/warroom-core/src/version.js';

const { values: v } = parseArgs({
  args: process.argv.slice(2),
  options: { home: { type: 'string' }, json: { type: 'boolean', default: false } },
});
const home = v.home ?? process.env.WARROOM_HOME ?? join(process.cwd(), '.warroom');
const checks = [];
const add = (name, status, detail = '') => checks.push({ name, status, detail }); // status: ok|warn|fail

// 环境
const nodeMajor = Number(process.versions.node.split('.')[0]);
const nodeMinor = Number(process.versions.node.split('.')[1]);
const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13);
add('Node ≥ 22.13（node:sqlite）', nodeOk ? 'ok' : 'fail', process.versions.node);
try { const d = new DatabaseSync(':memory:'); d.exec('CREATE TABLE t(a)'); d.close(); add('SQLite 可用', 'ok'); }
catch (e) { add('SQLite 可用', 'fail', e.message); }
add('docker daemon（围栏真实验收需要）', (() => {
  try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 4000 }); return 'ok'; }
  catch { return 'warn'; }
})(), '不可用时围栏验收会如实 SKIP');

// 数据
if (!existsSync(home)) add('WARROOM_HOME 存在', 'warn', `${home} 不存在（尚未开工）`);
else {
  add('WARROOM_HOME 可写', (() => {
    try { const f = join(home, '.doctor-write-test'); writeFileSync(f, 'x'); unlinkSync(f); return 'ok'; }
    catch { return 'fail'; }
  })());
  const g = join(home, 'global.db');
  if (!existsSync(g)) add('global.db', 'warn', '不存在（首次运行会创建）');
  else {
    const db = new DatabaseSync(g);
    const r = db.prepare('PRAGMA integrity_check').get();
    const verdict = r?.integrity_check ?? Object.values(r ?? {})[0];
    add('global.db 完整性', verdict === 'ok' ? 'ok' : 'fail', String(verdict));
    const ver = Number(db.prepare("SELECT v FROM meta WHERE k = 'schema_version:global'").get()?.v ?? 0);
    const target = targetVersionFor('global');
    add(`global schema 版本（${ver} → 期望 ${target}）`, ver <= target ? 'ok' : 'fail');
    db.close();
  }
  const engDir = join(home, 'engagements');
  if (existsSync(engDir)) {
    const engs = readdirSync(engDir).filter((d) => statSync(join(engDir, d)).isDirectory());
    let bad = 0;
    for (const e of engs) {
      const f = join(engDir, e, 'fact.db');
      if (!existsSync(f)) continue;
      const db = new DatabaseSync(f);
      const r = db.prepare('PRAGMA integrity_check').get();
      const verdict = r?.integrity_check ?? Object.values(r ?? {})[0];
      const ver = Number(db.prepare("SELECT v FROM meta WHERE k = 'schema_version:fact'").get()?.v ?? 0);
      if (verdict !== 'ok' || ver > SCHEMA_VERSION) bad += 1;
      db.close();
    }
    add(`战役库完整性（${engs.length} 个）`, bad === 0 ? 'ok' : 'fail', bad ? `${bad} 个异常` : '');
  } else add('战役目录', 'warn', '尚无战役');

  // 秘密
  const key = join(home, 'secrets', 'key.bin');
  if (!existsSync(key)) add('秘密密钥', 'warn', '尚未创建（首次登记秘密时生成）');
  else {
    const mode = statSync(key).mode & 0o777;
    add(`秘密密钥权限（${mode.toString(8)}）`, mode === 0o600 ? 'ok' : 'fail');
  }
  add('知识库', existsSync(join(home, 'knowledge.db')) ? 'ok' : 'warn', existsSync(join(home, 'knowledge.db')) ? '' : '尚未使用');

  // 备份新鲜度（>7 天提示；从未备份也给提示，但不阻塞）
  const latest = latestBackup({ home });
  if (!latest) add('最近备份', 'warn', '从未备份（建议 `warroom backup`）');
  else {
    const ageDays = (Date.now() - latest.mtime) / 86400000;
    add(`最近备份（${ageDays.toFixed(1)} 天前）`, ageDays <= 7 ? 'ok' : 'warn', ageDays > 7 ? '超过 7 天，建议重新备份' : '');
  }
}

const failed = checks.filter((c) => c.status === 'fail');
const warned = checks.filter((c) => c.status === 'warn');
if (v.json) console.log(JSON.stringify({ home, checks, failed: failed.length, warned: warned.length }, null, 2));
else {
  console.log(`warroom doctor · home=${home}`);
  for (const c of checks) {
    console.log(`  ${c.status === 'ok' ? '[✓]' : c.status === 'warn' ? '[!]' : '[✗]'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(`\n结论：${failed.length === 0 ? (warned.length ? '可用（有提示项）' : '全部正常') : `${failed.length} 项失败`}`);
}
process.exitCode = failed.length ? 1 : 0;
