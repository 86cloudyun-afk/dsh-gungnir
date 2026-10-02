import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, symlinkSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openEngagementDb, openGlobalDb } from '../packages/warroom-core/src/db.js';
import { FactStore } from '../packages/warroom-core/src/store.js';
import { JumphostManager } from '../packages/warroom-core/src/jumphosts.js';
import { readDashboardSnapshot, listDashboardEngagements, createDemoSnapshot } from '../packages/warroom-dashboard/src/snapshot.js';

const NOW = '2026-10-03T00:45:00.000Z';
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-real-home-'));
  const home = join(root, 'home'); mkdirSync(home);
  const global = openGlobalDb(home);
  const factDir = join(home, 'engagements', 'demo-eng-001');
  const fact = openEngagementDb(factDir);
  const addEng = fact.prepare(`INSERT INTO engagements (id,target_scope,window_start,window_end,allowed_means,action_class_limit,rhythm,auth_version,auth_object,auth_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  addEng.run('demo-eng-001','{}','','','','readonly','restricted',1,'{}','hash','2026-10-03T00:00:00.000Z');
  const addFact = fact.prepare(`INSERT INTO fact_members (adapter_instance,entity_type,source_id,revision_no,content_hash,payload,active,ts) VALUES (?,?,?,?,?,?,?,?)`);
  const ts='2026-10-03T02:00:00.000Z';
  const rows=[
    ['adapter-A','asset','same-id',1,{label:'asset same',state:'verified'}],
    ['adapter-B','asset','same-id',1,{label:'other adapter',state:'pending'}],
    ['adapter-A','evidence','same-id',1,{label:'evidence same',state:'unknown'}],
    ['adapter-A','chain','chain-1',1,{label:'chain',state:'failed',steps:[{from:'only-source',to:'asset-end',via:'fork step'}]}],
    ['adapter-A','asset','asset-end',1,{label:'asset end',state:'verified'}],
    ['adapter-A','asset','only-source',1,{label:'unique source'}],
    ['adapter-A','chain','typed-missing',1,{target:{adapter_instance:'adapter-A',entity_type:'asset',source_id:'absent'}}],
    ['adapter-A','chain','partial-typed',1,{target:{entity_type:'asset',source_id:'same-id'}}],
    ['adapter-A','chain','unknown-string',1,{via:'same-id'}],
    ['adapter-A','asset','bad-json',1,'{broken'],
    ['adapter-A','task','cancel-1',1,{state:'running',role:'fake',route_id:'old-route',task_id:'cancel-1'}],
    ['adapter-A','asset','revision-1',1,{label:'old'}],
  ];
  for (const [adapter,type,source,revision,payload] of rows) addFact.run(adapter,type,source,revision,`h${revision}`,typeof payload==='string'?payload:JSON.stringify(payload),1,ts);
  const old = fact.prepare("SELECT id FROM fact_members WHERE source_id='revision-1'").get();
  fact.prepare('UPDATE fact_members SET active=0,superseded_by=? WHERE id=?').run(old.id+1,old.id);
  addFact.run('adapter-A','asset','revision-1',2,'h2',JSON.stringify({label:'new'}),1,'2026-10-03T02:30:00.000Z');
  fact.prepare('INSERT INTO fact_seq(ts,note) VALUES(?,?)').run(ts,'fixture');
  fact.prepare('INSERT INTO jump_routes(route_id,lease_id,jumphost_id,socks,state,ts) VALUES(?,?,?,?,?,?)').run('live-route','lease-live','host-1','DO-NOT-EMIT','active','2026-10-03T00:00:00.000Z');
  fact.prepare('INSERT INTO jump_routes(route_id,lease_id,jumphost_id,socks,state,ts) VALUES(?,?,?,?,?,?)').run('expired-route','lease-expired','host-1','DO-NOT-EMIT','active','2026-10-02T00:00:00.000Z');
  fact.prepare('INSERT INTO egress_checks(ts,jumphost_id,exit_ip,verdict,route_id) VALUES(?,?,?,?,?)').run('2026-10-03T00:15:00.000Z','host-1','192.0.2.22','pass','expired-route');
  fact.prepare('INSERT INTO jump_routes(route_id,lease_id,jumphost_id,socks,state,ts) VALUES(?,?,?,?,?,?)').run('other-route','lease-live','host-1','DO-NOT-EMIT','active','2026-10-03T00:00:00.000Z');
  fact.prepare('INSERT INTO jump_routes(route_id,lease_id,jumphost_id,socks,state,ts) VALUES(?,?,?,?,?,?)').run('stale-route','lease-old','host-1','DO-NOT-EMIT','stale','2026-10-03T00:00:00.000Z');
  fact.prepare('INSERT INTO egress_checks(ts,jumphost_id,exit_ip,verdict,route_id) VALUES(?,?,?,?,?)').run('2026-10-03T00:30:00.000Z','host-1','192.0.2.20','pass','live-route');
  fact.prepare('INSERT INTO egress_checks(ts,jumphost_id,exit_ip,verdict,route_id) VALUES(?,?,?,?,?)').run('2026-10-03T02:30:00.000Z','host-1','192.0.2.21','pass','stale-route');
  fact.prepare('INSERT INTO shell_state(engagement_id,highest_proof,current_validity,last_verified_at) VALUES(?,?,?,?)').run('demo-eng-001','confirmed','likely','2026-10-03T02:00:00.000Z');
  global.prepare('INSERT INTO jumphosts(id,role,ssh_host,day,addr_v4,addr_v6) VALUES(?,?,?,?,?,?)').run('host-1','pure-relay','socks5://user:secret@127.0.0.1:5555','2026-10-03','192.0.2.1','2001:db8::1');
  global.prepare('INSERT INTO leases(lease_id,jumphost_id,engagement_id,state,expires_at,heartbeat_at,ts) VALUES(?,?,?,?,?,?,?)').run('lease-live','host-1','demo-eng-001','active','2026-10-03T04:00:00.000Z','2026-10-03T02:59:00.000Z','2026-10-03T00:00:00.000Z');
  global.prepare('INSERT INTO leases(lease_id,jumphost_id,engagement_id,state,expires_at,heartbeat_at,ts) VALUES(?,?,?,?,?,?,?)').run('lease-expired','host-1','demo-eng-001','active','2026-10-03T00:30:00.000Z','2026-10-03T00:00:00.000Z','2026-10-02T00:00:00.000Z');
  global.prepare('INSERT INTO leases(lease_id,jumphost_id,engagement_id,state,expires_at,heartbeat_at,ts) VALUES(?,?,?,?,?,?,?)').run('lease-old','host-1','demo-eng-001','released','2026-10-03T04:00:00.000Z','2026-10-03T02:59:00.000Z','2026-10-03T00:00:00.000Z');
  global.prepare('INSERT INTO command_queue(command_id,engagement_id,task_id,contract,state,generation,attempt,ts) VALUES(?,?,?,?,?,?,?,?)').run('cmd-done','demo-eng-001','task-done',JSON.stringify({role:'analyst'}),'done','g1',1,ts);
  global.prepare('INSERT INTO command_queue(command_id,engagement_id,task_id,contract,state,generation,attempt,ts) VALUES(?,?,?,?,?,?,?,?)').run('cmd-partial','demo-eng-001','task-partial','{}','partial','g1',1,ts);
  global.prepare('INSERT INTO command_queue(command_id,engagement_id,task_id,contract,state,generation,attempt,ts) VALUES(?,?,?,?,?,?,?,?)').run('cmd-unresolved','demo-eng-001','task-unresolved','{}','unresolved','g1',1,ts);
  global.prepare('INSERT INTO command_queue(command_id,engagement_id,task_id,contract,state,generation,attempt,ts) VALUES(?,?,?,?,?,?,?,?)').run('cmd-1','demo-eng-001','cancel-1',JSON.stringify({role:'worker',route_id:'live-route',auth:{token:'SECRET'},extra:'private'}),'confirmed_stopped','g1',1,ts);
  fact.close(); global.close();
  return {root,home,factPath:join(factDir,'fact.db'),globalPath:join(home,'global.db')};
}
function closeFixture(item) { rmSync(item.root,{recursive:true,force:true}); }

test('uses the core home layout, read-only transactions, and authoritative task state',()=>{
 const x=fixture(); try {
  writeFileSync(join(x.home,'warroom.json'),JSON.stringify({egressMaxAgeMin:60}));
  const before=[sha(x.factPath),sha(x.globalPath)];
  const snapshot=readDashboardSnapshot({home:x.home,engagementId:'demo-eng-001',now:NOW});
  assert.deepEqual([sha(x.factPath),sha(x.globalPath)],before);
  assert.equal(snapshot.engagement.engagement_id,'demo-eng-001'); assert.equal(snapshot.watermark.fact_seq,1);
  assert.equal(snapshot.nodes.length,11); assert.equal(new Set(snapshot.nodes.map((node)=>node.id)).size,11);
  assert(snapshot.edges.some((edge)=>edge.label==='fork step'&&edge.kind==='explicit'));
  assert(snapshot.diagnostics.ambiguous_refs>0); assert(snapshot.diagnostics.unresolved_refs>=1);
  assert.equal(snapshot.nodes.find((node)=>node.source_id==='same-id'&&node.adapter_instance==='adapter-B').state,'pending');
  assert.equal(snapshot.tasks.length,4);assert.equal(snapshot.tasks.find((task)=>task.task_id==='cancel-1').state,'confirmed_stopped');
  assert.equal(snapshot.tasks.find((task)=>task.task_id==='cancel-1').role,'worker');assert.equal(snapshot.tasks.find((task)=>task.task_id==='cancel-1').route_id,'live-route');
  assert.deepEqual(snapshot.tasks.map((task)=>task.state).sort(),['confirmed_stopped','done','partial','unresolved']);
  assert(!JSON.stringify(snapshot).includes('SECRET')); assert(!JSON.stringify(snapshot).includes('socks5://'));
  assert.equal(snapshot.diagnostics.shell_state.highest_proof,'confirmed');
  assert.equal(snapshot.nodes.find((node)=>node.entity_type==='shell')?.highest_proof ?? null,null);
  assert.equal(listDashboardEngagements({home:x.home})[0].engagement_id,'demo-eng-001');
 } finally {closeFixture(x);}
});

test('egress requires exact host, route, active lease era, non-recovered check, and freshness',()=>{
 const x=fixture(); try {
  const live=readDashboardSnapshot({home:x.home,engagementId:'demo-eng-001',now:NOW}).routes.find((route)=>route.route_id==='live-route');
  assert.equal(live.entry_ip,'192.0.2.1'); assert.equal(live.egress.current,true);
  assert.equal(readDashboardSnapshot({home:x.home,engagementId:'demo-eng-001',now:NOW}).routes.find((route)=>route.route_id==='other-route').egress.current,false);
  assert.equal(readDashboardSnapshot({home:x.home,engagementId:'demo-eng-001',now:NOW}).routes.find((route)=>route.route_id==='expired-route').egress.current,false);
  const mismatch=new DatabaseSync(x.factPath);mismatch.prepare('UPDATE egress_checks SET jumphost_id=? WHERE route_id=?').run('host-other','live-route');mismatch.close();
  assert.equal(readDashboardSnapshot({home:x.home,engagementId:'demo-eng-001',now:NOW}).routes.find((route)=>route.route_id==='live-route').egress.current,false);
  assert.equal(readDashboardSnapshot({home:x.home,engagementId:'demo-eng-001',now:'2026-10-03T02:00:00Z'}).routes.find((route)=>route.route_id==='live-route').egress.current,false);
  assert.equal(readDashboardSnapshot({home:x.home,engagementId:'demo-eng-001',now:'2026-10-03T04:00:00Z'}).routes.find((route)=>route.route_id==='live-route').egress.current,false);
  const db=new DatabaseSync(x.globalPath);
  db.prepare('UPDATE leases SET ts=? WHERE lease_id=?').run('2026-10-03T00:40:00Z','lease-live'); db.close();
  assert.equal(readDashboardSnapshot({home:x.home,engagementId:'demo-eng-001',now:NOW}).routes.find((route)=>route.route_id==='live-route').egress.current,false);
  const recovered=new DatabaseSync(x.factPath);recovered.prepare('UPDATE egress_checks SET jumphost_id=?,recovered_at=? WHERE route_id=?').run('host-1',NOW,'live-route');recovered.close();
  assert.equal(readDashboardSnapshot({home:x.home,engagementId:'demo-eng-001',now:NOW}).routes.find((route)=>route.route_id==='live-route').egress.current,false);
 } finally {closeFixture(x);}
});


test('normal JumphostManager heartbeat preserves a fresh exact-route pass',()=>{
 const x=fixture(); const global=new DatabaseSync(x.globalPath); const fact=new DatabaseSync(x.factPath);
 try {
  const manager=new JumphostManager({globalDb:global,getFactStore:()=>new FactStore(fact,'demo-eng-001'),ttlMinutes:30});
  const RealDate=globalThis.Date;
  try {
   globalThis.Date=class extends RealDate {
    constructor(...args){super(...(args.length?args:['2026-10-03T00:45:00.000Z']));}
    static now(){return RealDate.parse('2026-10-03T00:45:00.000Z');}
   };
   manager.heartbeatRoute({route_id:'live-route',engagementId:'demo-eng-001'});
  } finally {globalThis.Date=RealDate;}
  const snapshot=readDashboardSnapshot({home:x.home,engagementId:'demo-eng-001',now:'2026-10-03T00:50:00.000Z'});
  assert.equal(snapshot.routes.find((route)=>route.route_id==='live-route').egress.current,true);
 } finally {fact.close();global.close();closeFixture(x);}
});

test('home engagement ID mismatch, path escapes, missing/corrupt databases fail with stable codes',()=>{
 const x=fixture(); const outside=mkdtempSync(join(tmpdir(),'dashboard-outside-'));
 try {
  const wrong=join(x.home,'engagements','wrong-id'); mkdirSync(wrong,{recursive:true}); symlinkSync(x.factPath,join(wrong,'fact.db'));
  assert.throws(()=>readDashboardSnapshot({home:x.home,engagementId:'wrong-id'}),e=>e.code==='E_DASHBOARD_NOT_FOUND');
  const escaped=join(outside,'escaped-engagement');mkdirSync(escaped);copyFileSync(x.factPath,join(escaped,'fact.db'));
  symlinkSync(escaped,join(x.home,'engagements','escape-link'));
  assert.throws(()=>readDashboardSnapshot({home:x.home,engagementId:'escape-link'}),e=>e.code==='E_DASHBOARD_PATH');
  assert.throws(()=>readDashboardSnapshot({home:x.home,engagementId:'absent'}),e=>e.code==='E_DASHBOARD_NOT_FOUND');
  const corrupt=join(outside,'corrupt-home');mkdirSync(join(corrupt,'engagements','broken'),{recursive:true});writeFileSync(join(corrupt,'engagements','broken','fact.db'),'not sqlite');openGlobalDb(corrupt).close();
  assert.throws(()=>readDashboardSnapshot({home:corrupt,engagementId:'broken'}),e=>e.code==='E_DASHBOARD_DATABASE');
  const corruptGlobalHome=join(outside,'corrupt-global-home');mkdirSync(join(corruptGlobalHome,'engagements','demo-eng-001'),{recursive:true});copyFileSync(x.factPath,join(corruptGlobalHome,'engagements','demo-eng-001','fact.db'));writeFileSync(join(corruptGlobalHome,'global.db'),'not sqlite');
  assert.throws(()=>readDashboardSnapshot({home:corruptGlobalHome,engagementId:'demo-eng-001'}),e=>e.code==='E_DASHBOARD_DATABASE');
  const missingGlobalHome=join(outside,'missing-global-home');mkdirSync(join(missingGlobalHome,'engagements','demo-eng-001'),{recursive:true});copyFileSync(x.factPath,join(missingGlobalHome,'engagements','demo-eng-001','fact.db'));
  assert.throws(()=>readDashboardSnapshot({home:missingGlobalHome,engagementId:'demo-eng-001'}),e=>e.code==='E_DASHBOARD_DATABASE');
  const globalOriginal=join(outside,'global-original.db');copyFileSync(x.globalPath,globalOriginal);
  renameSync(x.globalPath,join(x.home,'global-backup.db'));symlinkSync(globalOriginal,x.globalPath);
  assert.throws(()=>readDashboardSnapshot({home:x.home,engagementId:'demo-eng-001'}),e=>e.code==='E_DASHBOARD_PATH');
  const brokenHome=join(outside,'broken');mkdirSync(brokenHome);writeFileSync(join(brokenHome,'global.db'),'not sqlite');
  assert.throws(()=>readDashboardSnapshot({home:brokenHome,engagementId:'none'}),e=>e.code==='E_DASHBOARD_NOT_FOUND');
  assert.equal(existsSync(join(outside,'created-home')),false);
 } finally {closeFixture(x);rmSync(outside,{recursive:true,force:true});}
});

test('invalid egress config fails closed with diagnostics',()=>{const x=fixture();try{writeFileSync(join(x.home,'warroom.json'),'{broken');const snapshot=readDashboardSnapshot({home:x.home,engagementId:'demo-eng-001',now:NOW});assert.equal(snapshot.routes.find((route)=>route.route_id==='live-route').egress.current,false);assert(snapshot.diagnostics.warnings.some((warning)=>warning.includes('configuration is invalid')));}finally{closeFixture(x);}});

test('demo has a closed four-route, five-rank graph and navigable synthetic conversation',()=>{
 const demo=createDemoSnapshot();assert.equal(demo.mode,'demo');assert.equal(demo.routes.length,4);assert(demo.nodes.length>=20);assert.equal(new Set(demo.nodes.map((node)=>node.layer)).size,5);
 assert.equal(demo.conversation.messages.length,4);assert(demo.nodes.some((node)=>node.state==='unknown'));
 assert.deepEqual(demo.routes.map((route)=>route.egress.verdict),['pass','pending','fail','pass']);
 for(const route of demo.routes){const nodeSet=new Set(route.node_ids);assert(nodeSet.size>1);for(const edgeId of route.edge_ids){const edge=demo.edges.find((item)=>item.id===edgeId);assert(nodeSet.has(edge.from));assert(nodeSet.has(edge.to));}}
 assert(demo.routes.every((route)=>route.entry_ip&&route.exit_ip&&route.lease.state==='active'));
 assert(demo.nodes.every((node)=>node.source_id.startsWith('demo-')));
});

test('superseding a fact revision keeps its triple identity',()=>{
 const x=fixture();try{const before=readDashboardSnapshot({home:x.home,engagementId:'demo-eng-001',now:NOW});const node=before.nodes.find((item)=>item.source_id==='revision-1');assert(node.id.startsWith('fact:'));assert.equal(node.state,'unknown');const db=new DatabaseSync(x.factPath);db.prepare('UPDATE fact_members SET active=0 WHERE adapter_instance=? AND entity_type=? AND source_id=? AND active=1').run('adapter-A','asset','revision-1');db.prepare('INSERT INTO fact_members(adapter_instance,entity_type,source_id,revision_no,content_hash,payload,active,ts) VALUES(?,?,?,?,?,?,?,?)').run('adapter-A','asset','revision-1',3,'h3',JSON.stringify({label:'third revision'}),1,'2026-10-03T02:45:00Z');db.close();const after=readDashboardSnapshot({home:x.home,engagementId:'demo-eng-001',now:NOW});assert.equal(after.nodes.find((item)=>item.source_id==='revision-1').id,node.id);assert.equal(after.nodes.find((item)=>item.source_id==='revision-1').label,'third revision');}finally{closeFixture(x);}
});
