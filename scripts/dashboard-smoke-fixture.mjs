// Temporary synthetic data for browser acceptance; never reads a running WARROOM home.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openEngagementDb, openGlobalDb } from '../packages/warroom-core/src/db.js';
import { createDemoSnapshot } from '../packages/warroom-dashboard/src/demo.js';
import { readDashboardSnapshot } from '../packages/warroom-dashboard/src/snapshot.js';

export function createDashboardSmokeFixture({ sessionIds = ['browser-session-a', 'browser-session-b'], extraNodes = 0 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gungnir-dashboard-browser-'));
  const engagementId = 'browser-fixture';
  const factPath = join(home, 'engagements', engagementId, 'fact.db');
  const globalPath = join(home, 'global.db');
  const demo = createDemoSnapshot();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.parse(now) + 3600000).toISOString();
  const adapter = 'browser-fixture';
  const fact = openEngagementDb(join(home, 'engagements', engagementId));
  const global = openGlobalDb(home);
  try {
    fact.prepare(`INSERT INTO engagements
      (id,target_scope,window_start,window_end,allowed_means,action_class_limit,rhythm,auth_version,auth_object,auth_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(engagementId, '{}', '', '', '', 'readonly', 'restricted', 1, '{}', 'synthetic-fixture', now);
    const nodes = new Map(demo.nodes.map(node => [node.id, node]));
    const reference = id => {
      const node = nodes.get(id);
      return { adapter_instance: adapter, entity_type: node.entity_type, source_id: node.source_id };
    };
    const addFact = fact.prepare(`INSERT INTO fact_members
      (adapter_instance,entity_type,source_id,revision_no,content_hash,payload,active,ts) VALUES (?,?,?,?,?,?,?,?)`);
    for (const node of demo.nodes) {
      const payload = {
        label: node.label, layer: node.layer, state: node.state, route_ids: node.route_ids, task_ids: node.task_ids,
        edges: demo.edges.filter(edge => edge.from === node.id).map(edge => ({
          to: reference(edge.to), label: edge.label, kind: edge.kind, route_ids: edge.route_ids,
        })),
      };
      if (node.source_id === 'demo-asset-a') payload.task_ids = ['fixture-task'];
      addFact.run(adapter, node.entity_type, node.source_id, 1, 'fixture', JSON.stringify(payload), 1, now);
    }
    for (let index = 0; index < extraNodes; index += 1) {
      addFact.run(adapter, 'evidence', `large-fixture-${index}`, 1, 'fixture', JSON.stringify({ label: `额外证据 ${index}`, state: index % 4 === 0 ? 'failed' : 'unknown' }), 1, now);
    }
    fact.prepare('INSERT INTO fact_seq(ts,note) VALUES(?,?)').run(now, 'synthetic browser fixture');
    for (const route of demo.routes) {
      const leaseId = `lease-${route.route_id}`;
      global.prepare('INSERT INTO jumphosts(id,role,ssh_host,day,addr_v4) VALUES(?,?,?,?,?)')
        .run(route.jumphost_id, 'pure-relay', 'synthetic.invalid', now.slice(0, 10), route.entry_ip);
      global.prepare(`INSERT INTO leases
        (lease_id,jumphost_id,engagement_id,state,expires_at,heartbeat_at,ts) VALUES(?,?,?,?,?,?,?)`)
        .run(leaseId, route.jumphost_id, engagementId, 'active', expiresAt, now, now);
      fact.prepare('INSERT INTO jump_routes(route_id,lease_id,jumphost_id,socks,state,ts) VALUES(?,?,?,?,?,?)')
        .run(route.route_id, leaseId, route.jumphost_id, 'synthetic-only', 'active', now);
      fact.prepare('INSERT INTO egress_checks(ts,jumphost_id,exit_ip,verdict,route_id) VALUES(?,?,?,?,?)')
        .run(now, route.jumphost_id, route.exit_ip, route.egress.verdict, route.route_id);
    }
    global.prepare(`INSERT INTO command_queue
      (command_id,engagement_id,task_id,contract,state,generation,attempt,ts) VALUES(?,?,?,?,?,?,?,?)`)
      .run('fixture-command', engagementId, 'fixture-task', JSON.stringify({ role: 'synthetic', route_id: 'demo-route-02' }), 'done', 'fixture', 1, now);
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  } finally {
    fact.close();
    global.close();
  }
  const snapshot = readDashboardSnapshot({ home, engagementId });
  const selected = snapshot.nodes.find(node => node.source_id === 'demo-asset-a');
  const messages = [
    { id: 'fixture-user', role: 'user', text: `[Synthetic smoke fixture] 查看 ${selected.source_id}`, created_at: now, node_ids: [selected.id], route_ids: selected.route_ids },
    { id: 'fixture-assistant', role: 'assistant', text: `[Synthetic smoke fixture] 已记录 ${selected.source_id} 的共享链路。`, created_at: now, node_ids: [selected.id] },
    { id: 'fixture-route-only', role: 'assistant', text: '[Synthetic smoke fixture] 查看路线 demo-route-02。', created_at: now, route_ids: ['demo-route-02'] },
    { id: 'fixture-task-only', role: 'user', text: '[Synthetic smoke fixture] 查看任务 fixture-task。', created_at: now, task_ids: ['fixture-task'] },
  ];
  return {
    home, engagementId, snapshot, messages, sessionIds,
    conversationProvider: {
      async listSessions() { return sessionIds.map((id, index) => ({ id, title: `Synthetic session ${index + 1}` })); },
      async readMessages(id) { return sessionIds.includes(id) ? messages : []; },
    },
    hashes() {
      const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
      return { fact: hash(factPath), global: hash(globalPath) };
    },
    dispose() { rmSync(home, { recursive: true, force: true }); },
  };
}
