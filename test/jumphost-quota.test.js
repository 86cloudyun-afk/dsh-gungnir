// 固定时钟 + 新建 WAL 数据库；子进程只做本地配额/合成事实记账，不连接出口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GLOBAL_DDL, FACT_DDL } from '../packages/warroom-core/src/db.js';
import { FactStore } from '../packages/warroom-core/src/store.js';
import { JumphostManager } from '../packages/warroom-core/src/jumphosts.js';

const OLD = '2026-10-05T23:59:59.000Z';
const NEXT = '2026-10-06T00:00:01.000Z';
const moduleUrl = (name) => new URL(`../packages/warroom-core/src/${name}.js`, import.meta.url).href;
function fixture(t, { quota = 3, day = OLD.slice(0, 10), used = 0, egressProbe } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(OLD) });
  const home = mkdtempSync(join(tmpdir(), 'jumphost-quota-'));
  const file = join(home, 'global.db');
  const g = new DatabaseSync(file);
  g.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  g.exec(GLOBAL_DDL);
  const db = new DatabaseSync(':memory:');
  db.exec(FACT_DDL);
  const store = new FactStore(db, 'synthetic-a');
  const jm = new JumphostManager({ globalDb: g, getFactStore: () => store, egressProbe });
  jm.importHosts([{ id: 'fixture', addr_v4: '192.0.2.10', quota }]);
  g.prepare("UPDATE jumphosts SET day=?, used_today=? WHERE id='fixture'").run(day, used);
  t.after(() => { db.close(); g.close(); });
  return { file, g, db, store, jm, acquire: () => jm.acquire({ engagement_id: 'synthetic-a', jumphost_id: 'fixture' }) };
}
function childAcquire(file, iso) {
  const code = `
    import { DatabaseSync } from 'node:sqlite';
    import { FACT_DDL } from ${JSON.stringify(moduleUrl('db'))};
    import { FactStore } from ${JSON.stringify(moduleUrl('store'))};
    import { JumphostManager } from ${JSON.stringify(moduleUrl('jumphosts'))};
    const NativeDate=Date, ms=NativeDate.parse(process.argv[2]);
    globalThis.Date=class extends NativeDate {
      constructor(...args){super(...(args.length?args:[ms]));}
      static now(){return ms;}
    };
    const g=new DatabaseSync(process.argv[1]);
    g.exec('PRAGMA busy_timeout=5000');
    const db=new DatabaseSync(':memory:'); db.exec(FACT_DDL);
    const store=new FactStore(db,'synthetic-b');
    const jm=new JumphostManager({globalDb:g,getFactStore:()=>store});
    let result;
    try { result={ok:true,lease_id:jm.acquire({engagement_id:'synthetic-b',jumphost_id:'fixture'}).lease_id}; }
    catch(e){result={ok:false,code:e.code,message:e.message};}
    result.row=g.prepare('SELECT day,used_today FROM jumphosts').get();
    result.routes=db.prepare('SELECT COUNT(*) n FROM jump_routes').get().n;
    console.log(JSON.stringify(result)); db.close(); g.close();
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, file, iso], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const bucket = (g) => ({ ...g.prepare("SELECT day, used_today FROM jumphosts WHERE id='fixture'").get() });
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

test('配额跨进程：旧日请求晚完成不得回退新日桶或漏掉新日用量', (t) => {
  let b;
  const f = fixture(t, { egressProbe: () => { b = childAcquire(f.file, NEXT); return { ok: true, exit_ip: '192.0.2.10' }; } });
  f.acquire();
  assert.equal(b.ok, true);
  assert.deepEqual(bucket(f.g), { day: NEXT.slice(0, 10), used_today: 1 });
  t.mock.timers.setTime(Date.parse(NEXT));
  f.jm.egressProbe = () => ({ ok: true, exit_ip: '192.0.2.10' });
  f.acquire(); f.acquire();
  assert.equal(bucket(f.g).used_today, 3);
  assert.throws(f.acquire, { code: 'E_NO_JUMPHOST' });
});

test('配额跨进程：同日最后一个槽位只允许一个请求探测和发布路由', (t) => {
  let b;
  const f = fixture(t, { quota: 1, egressProbe: () => { b = childAcquire(f.file, OLD); return { ok: true, exit_ip: '192.0.2.10' }; } });
  f.acquire();
  assert.equal(b.ok, false);
  assert.equal(b.code, 'E_NO_JUMPHOST');
  assert.equal(b.routes, 0);
  assert.equal(bucket(f.g).used_today, 1);
  assert.equal(count(f.g, 'leases'), 1);
  assert.equal(count(f.g, 'op_log'), 1);
});

test('配额跨进程：同日可用槽位均保留计数，没有丢失更新', (t) => {
  let b;
  const f = fixture(t, { quota: 2, egressProbe: () => { b = childAcquire(f.file, OLD); return { ok: true, exit_ip: '192.0.2.10' }; } });
  f.acquire();
  assert.equal(b.ok, true);
  assert.equal(bucket(f.g).used_today, 2);
  assert.equal(count(f.g, 'leases'), 2);
  assert.throws(f.acquire, { code: 'E_NO_JUMPHOST' });
});

test('配额补偿：旧日失败不得归还新日成功请求的槽位', (t) => {
  let b;
  const f = fixture(t, { egressProbe: () => { b = childAcquire(f.file, NEXT); return { ok: false }; } });
  assert.throws(f.acquire, { code: 'E_COMPENSATED' });
  assert.equal(b.ok, true);
  assert.deepEqual(bucket(f.g), { day: NEXT.slice(0, 10), used_today: 1 });
  assert.equal(f.g.prepare("SELECT COUNT(*) n FROM leases WHERE state='released'").get().n, 1);
});

test('配额补偿：同日失败仅归还自己的预留，保留并发成功计数', (t) => {
  let b;
  const f = fixture(t, { quota: 2, egressProbe: () => { b = childAcquire(f.file, OLD); return { ok: false }; } });
  assert.throws(f.acquire, { code: 'E_COMPENSATED' });
  assert.equal(b.ok, true);
  assert.equal(bucket(f.g).used_today, 1);
  f.jm.egressProbe = () => ({ ok: true, exit_ip: '192.0.2.10' });
  f.acquire();
  assert.equal(bucket(f.g).used_today, 2);
});

test('配额时钟回退：数据库已有更新日期时拒绝且不写任何库', (t) => {
  let probes = 0;
  const f = fixture(t, { day: NEXT.slice(0, 10), used: 2, egressProbe: () => { probes++; return { ok: true }; } });
  const changes = f.g.prepare('SELECT total_changes() n').get().n;
  f.g.exec('PRAGMA query_only=ON'); f.db.exec('PRAGMA query_only=ON');
  assert.throws(f.acquire, { code: 'E_NO_JUMPHOST' });
  assert.deepEqual(bucket(f.g), { day: NEXT.slice(0, 10), used_today: 2 });
  assert.equal(f.g.prepare('SELECT total_changes() n').get().n, changes);
  assert.equal(probes, 0);
  assert.equal(count(f.g, 'op_log'), 0);
  assert.equal(count(f.db, 'jump_routes'), 0);
});

test('配额普通跨天：往日满额恢复，今日满额拒绝不触发DB写或探测', (t) => {
  const f = fixture(t, { day: '2026-10-04', used: 3 });
  f.acquire(); f.acquire(); f.acquire();
  assert.deepEqual(bucket(f.g), { day: OLD.slice(0, 10), used_today: 3 });
  const changes = f.g.prepare('SELECT total_changes() n').get().n;
  f.g.exec('PRAGMA query_only=ON'); f.db.exec('PRAGMA query_only=ON');
  f.jm.egressProbe = () => assert.fail('exhausted quota must not probe');
  assert.throws(f.acquire, { code: 'E_NO_JUMPHOST' });
  assert.equal(f.g.prepare('SELECT total_changes() n').get().n, changes);
  assert.equal(count(f.g, 'op_log'), 3);
  assert.equal(count(f.db, 'jump_routes'), 3);
});

test('配额写失败补偿：fact错误归还预留，租约释放及op审计保持', (t) => {
  const f = fixture(t, { quota: 1 });
  f.store.faults.write_fail = true;
  assert.throws(f.acquire, { code: 'E_COMPENSATED' });
  assert.equal(bucket(f.g).used_today, 0);
  assert.equal(f.g.prepare('SELECT state FROM leases').get().state, 'released');
  assert.equal(f.g.prepare('SELECT state FROM op_log').get().state, 'released');
  assert.equal(f.jm.teardowns.length, 1);
  assert.equal(count(f.db, 'jump_routes'), 0);
  f.store.faults.write_fail = false;
  f.acquire();
  assert.equal(bucket(f.g).used_today, 1);
});

for (const [label, iso] of [['同日抢占最后槽位', OLD], ['新日先完成记账', NEXT]]) {
  test(`配额选择后竞态：${label}，旧选择必须重新验证且不遗留意图/租约`, (t) => {
    const f = fixture(t, { quota: 1 });
    let b, probes = 0, raced = false;
    // 在真实写事务前插入另一个进程的完整 acquire，保留最初已选中的旧快照。
    f.jm.g = {
      prepare: (sql) => f.g.prepare(sql),
      exec: (sql) => {
        if (sql === 'BEGIN IMMEDIATE' && !raced) { raced = true; b = childAcquire(f.file, iso); }
        return f.g.exec(sql);
      },
    };
    f.jm.egressProbe = () => { probes++; return { ok: true }; };
    assert.throws(f.acquire, { code: 'E_NO_JUMPHOST' });
    assert.equal(b.ok, true);
    assert.deepEqual(bucket(f.g), { day: iso.slice(0, 10), used_today: 1 });
    assert.equal(probes, 0);
    assert.equal(count(f.g, 'op_log'), 1);
    assert.equal(count(f.g, 'leases'), 1);
    assert.equal(count(f.db, 'jump_routes'), 0);
  });
}

test('配额预留事务：租约插入失败回滚配额与意图，之后仍可分配', (t) => {
  const f = fixture(t, { quota: 1 });
  f.g.exec("CREATE TRIGGER synthetic_lease_failure BEFORE INSERT ON leases BEGIN SELECT RAISE(ABORT, 'synthetic lease failure'); END;");
  assert.throws(f.acquire, /synthetic lease failure/);
  assert.equal(bucket(f.g).used_today, 0);
  assert.equal(count(f.g, 'op_log'), 0);
  assert.equal(count(f.g, 'leases'), 0);
  assert.equal(count(f.db, 'jump_routes'), 0);
  f.g.exec('DROP TRIGGER synthetic_lease_failure');
  f.acquire();
  assert.equal(bucket(f.g).used_today, 1);
});

test('配额补偿事务：租约释放写失败时保留预留，禁止未释放租约脱离配额', (t) => {
  const f = fixture(t, { quota: 1, egressProbe: () => ({ ok: false }) });
  f.g.exec("CREATE TRIGGER synthetic_release_failure BEFORE UPDATE OF state ON leases WHEN NEW.state='released' BEGIN SELECT RAISE(ABORT, 'synthetic release failure'); END;");
  assert.throws(f.acquire, /synthetic release failure/);
  assert.equal(bucket(f.g).used_today, 1);
  assert.equal(f.g.prepare('SELECT state FROM leases').get().state, 'active');
  assert.equal(f.g.prepare('SELECT state FROM op_log').get().state, 'intent');
  assert.throws(f.acquire, { code: 'E_NO_JUMPHOST' });
});
