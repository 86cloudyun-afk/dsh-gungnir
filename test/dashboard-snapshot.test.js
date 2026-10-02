import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readDashboardSnapshot, listDashboardEngagements, createDemoSnapshot } from '../packages/warroom-dashboard/src/snapshot.js';

const digest = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dash-snap-'));
  const home = join(root, 'home'), dir = join(home, 'warroom/engagements/demo-eng-001');
  mkdirSync(dir, { recursive: true });
  const f = new DatabaseSync(join(dir, 'fact.db'));
  f.exec(`CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT); CREATE TABLE engagements(id TEXT PRIMARY KEY,target_scope TEXT,window_start TEXT,window_end TEXT,allowed_means TEXT,action_class_limit TEXT,rhythm TEXT,auth_version INTEGER,auth_object TEXT,auth_hash TEXT,user_message_id TEXT,created_at TEXT);
    CREATE TABLE fact_members(id INTEGER PRIMARY KEY,adapter_instance TEXT,entity_type TEXT,source_id TEXT,revision_no INTEGER,content_hash TEXT,payload TEXT,generation TEXT,active INTEGER,superseded_by INTEGER,flags TEXT,ts TEXT);
    CREATE TABLE fact_seq(id INTEGER PRIMARY KEY,ts TEXT,note TEXT); CREATE TABLE jump_routes(route_id TEXT PRIMARY KEY,lease_id TEXT,jumphost_id TEXT,socks TEXT,state TEXT,ts TEXT);
    CREATE TABLE egress_checks(id INTEGER PRIMARY KEY,ts TEXT,jumphost_id TEXT,exit_ip TEXT,verdict TEXT,route_id TEXT,recovered_at TEXT);`);
  f.prepare('INSERT INTO engagements VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('demo-eng-001','example', '', '', '', '', '',1,'{}','hash',null,'2026-10-03T00:00:00Z');
  const add = f.prepare('INSERT INTO fact_members(adapter_instance,entity_type,source_id,revision_no,content_hash,payload,generation,active,ts) VALUES(?,?,?,?,?,?,?,?,?)');
  const rows = [
    ['adapter-A','asset','same-id',{label:'asset same',state:'verified',layer:1}],
    ['adapter-B','asset','same-id',{label:'other adapter',state:'pending',layer:1}],
    ['adapter-A','evidence','same-id',{label:'evidence same',state:'unknown',layer:2}],
    ['adapter-A','chain','chain-1',{label:'chain',state:'failed',layer:3,refs:[{adapter_instance:'adapter-A',entity_type:'asset',source_id:'same-id'}],edges:[{to:{adapter_instance:'adapter-A',entity_type:'asset',source_id:'same-id'},kind:'explicit',label:'supports'}]}],
    ['adapter-A','asset','ambiguous-ref',{label:'ambiguous',refs:[{source_id:'same-id'}]}],
    ['adapter-A','asset','missing-ref',{label:'missing',refs:[{source_id:'not-found'}]}],
    ['adapter-A','task','cancel-1',{state:'cancel_requested',role:'worker',route_id:'route-live',task_id:'cancel-1'}],
  ];
  for (const [a,t,s,p] of rows) add.run(a,t,s,1,'h',JSON.stringify(p),null,1,'2026-10-03T00:00:00Z');
  add.run('adapter-A','asset','bad-json',1,'h','{bad',null,1,'2026-10-03T00:00:00Z');
  f.prepare('INSERT INTO fact_seq(ts,note) VALUES(?,?)').run('2026-10-03T00:00:00Z','seed');
  f.prepare('INSERT INTO jump_routes VALUES(?,?,?,?,?,?)').run('route-live','lease-live','host-1',null,'active','2026-10-03T00:00:00Z');
  f.prepare('INSERT INTO jump_routes VALUES(?,?,?,?,?,?)').run('route-old','lease-old','host-1',null,'released','2026-10-02T00:00:00Z');
  f.prepare('INSERT INTO egress_checks(ts,jumphost_id,exit_ip,verdict,route_id) VALUES(?,?,?,?,?)').run('2026-10-03T00:00:00Z','host-1','192.0.2.9','pass','route-live');
  f.prepare('INSERT INTO egress_checks(ts,jumphost_id,exit_ip,verdict,route_id) VALUES(?,?,?,?,?)').run('2026-10-03T00:00:00Z','host-1','192.0.2.8','pass','route-old');
  f.close();
  const g = new DatabaseSync(join(home,'global.db'));
  g.exec('CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT); CREATE TABLE leases(lease_id TEXT PRIMARY KEY,jumphost_id TEXT,engagement_id TEXT,state TEXT,expires_at TEXT,heartbeat_at TEXT,ts TEXT); CREATE TABLE command_queue(last_heartbeat_at TEXT,command_id TEXT PRIMARY KEY,engagement_id TEXT,task_id TEXT,contract TEXT,state TEXT,generation TEXT,attempt INTEGER,ts TEXT);');
  g.prepare('INSERT INTO leases VALUES(?,?,?,?,?,?,?)').run('lease-old','host-1','demo-eng-001','released','2026-10-02T01:00:00Z','2026-10-02T00:00:00Z','2026-10-02T00:00:00Z');
  g.prepare('INSERT INTO leases VALUES(?,?,?,?,?,?,?)').run('lease-live','host-1','demo-eng-001','active','2026-10-03T01:00:00Z','2026-10-03T00:00:00Z','2026-10-03T00:00:00Z');
  g.prepare('INSERT INTO command_queue VALUES(?,?,?,?,?,?,?,?,?)').run(null,'cmd-1','demo-eng-001','cancel-1','{}','cancel_requested',null,1,'2026-10-03T00:00:00Z');
  g.close(); return {root,home, fact:join(dir,'fact.db'),global:join(home,'global.db')};
}

test('snapshot is read-only, isolated, identity-safe, and diagnoses references', () => {
  const x=fixture(); try {
    const before=[digest(x.fact),digest(x.global)];
    const s=readDashboardSnapshot({home:x.home,engagementId:'demo-eng-001',now:'2026-10-03T00:30:00Z'});
    assert.deepEqual([digest(x.fact),digest(x.global)],before);
    assert.equal(s.nodes.length,7); assert(s.diagnostics.warnings.some(w=>w.includes('Malformed payload'))); assert.equal(new Set(s.nodes.map(n=>n.id)).size,7);
    assert(s.edges.some(e=>e.kind==='explicit'));
    assert(s.diagnostics.ambiguous_refs>0); assert(s.diagnostics.unresolved_refs>0);
    const live=s.routes.find(r=>r.route_id==='route-live'); assert.equal(live.egress.verdict,'pass'); assert.equal(live.egress.current,true);
    const old=s.routes.find(r=>r.route_id==='route-old'); assert.equal(old.egress.current,false);
    assert.equal(s.tasks[0].state,'cancel_requested');
    assert.equal(s.nodes.find(n=>n.source_id==='same-id'&&n.adapter_instance==='adapter-B').state,'pending');
    assert.equal(listDashboardEngagements({home:x.home}).length,1);
  } finally {rmSync(x.root,{recursive:true,force:true});}
});
test('missing home stays absent and missing engagement has stable code',()=>{
 const root=mkdtempSync(join(tmpdir(),'dash-empty-')); const home=join(root,'absent');
 try {assert.throws(()=>listDashboardEngagements({home}),e=>e.code==='E_DASHBOARD_PATH');assert.equal(existsSync(home),false);
 const x=fixture(); try {assert.throws(()=>readDashboardSnapshot({home:x.home,engagementId:'nope'}),e=>e.code==='E_DASHBOARD_NOT_FOUND');} finally {rmSync(x.root,{recursive:true,force:true});}
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('demo is marked and has four hosts with fork, merge, and shared evidence',()=>{
 const d=createDemoSnapshot(); assert.equal(d.mode,'demo');assert.equal(d.routes.length,4);assert(d.nodes.every(n=>/^(demo|example)-/.test(n.source_id)));assert(d.edges.some(e=>e.kind==='explicit'));assert(d.routes.some(r=>r.egress.verdict==='pending'));assert(d.routes.some(r=>r.egress.verdict==='fail'));
});
test('empty engagement returns an honest empty live snapshot',()=>{
 const x=fixture(); const db=new DatabaseSync(x.fact); db.exec('DELETE FROM fact_members'); db.close();
 try {const s=readDashboardSnapshot({home:x.home,engagementId:'demo-eng-001'});assert.equal(s.mode,'live');assert.deepEqual(s.nodes,[]);assert.deepEqual(s.edges,[]);assert.equal(s.diagnostics.counts.nodes,0);} finally {rmSync(x.root,{recursive:true,force:true});}
});
