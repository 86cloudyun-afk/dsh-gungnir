import { DatabaseSync } from 'node:sqlite';
import { existsSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { projectFacts } from './model.js';
import { createDemoSnapshot } from './demo.js';
import { loadConfig } from '../../warroom-core/src/config.js';

const SNAPSHOT_SCHEMA = 'gungnir-dashboard/1';
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const err = (code, message) => Object.assign(new Error(message), { code });

export function listDashboardEngagements({ home }) {
  const paths = resolveHomePaths(home);
  if (!existsSync(paths.engagementsRoot)) return [];
  let directories;
  try { directories = readdirSync(paths.engagementsRoot, { withFileTypes: true }); }
  catch (error) { throw err('E_DASHBOARD_PATH', `Cannot list engagements: ${error.message}`); }
  const result = [];
  for (const entry of directories) {
    if (!entry.isDirectory() || !SAFE_SEGMENT.test(entry.name)) continue;
    const engagement = readEngagement(paths, entry.name, { allowMissing: true });
    if (engagement) result.push({ engagement_id: engagement.id, created_at: engagement.created_at ?? null });
  }
  return result.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
}

export function readDashboardSnapshot({ home, engagementId, now = new Date().toISOString() }) {
  const paths = resolveHomePaths(home);
  const id = String(engagementId ?? '');
  if (!SAFE_SEGMENT.test(id)) throw err('E_DASHBOARD_PATH', 'Invalid engagement id');
  const engagement = readEngagement(paths, id);
  const factDb = openReadOnly(engagement.factPath);
  let globalDb;
  try {
    globalDb = openReadOnly(paths.globalPath);
    const factTables = tableNames(factDb);
    const globalTables = tableNames(globalDb);
    const diagnostics = emptyDiagnostics();
    factDb.exec('BEGIN');
    globalDb.exec('BEGIN');

    const factRows = rowsIfTable(factDb, factTables, 'fact_members', `
      SELECT id, adapter_instance, entity_type, source_id, revision_no, payload, active, ts
      FROM fact_members WHERE active = 1 ORDER BY id`);
    const model = projectFacts(factRows, diagnostics);
    const routes = projectRoutes(factDb, factTables, globalDb, globalTables, id, now, paths.base, diagnostics);
    const tasks = projectTasks(model.facts, globalDb, globalTables, id, diagnostics);
    attachRouteAssociations(routes, model.nodes, model.edges);
    const shellState = readShellState(factDb, factTables, id);
    if (!tableNames(factDb).has('shell_state')) {
      diagnostics.warnings.push('Authoritative shell_state table is unavailable; shell proof and validity are unknown.');
    }
    const watermark = readWatermark(factDb, factTables);
    diagnostics.counts = {
      nodes: model.nodes.length,
      edges: model.edges.length,
      routes: routes.length,
      tasks: tasks.length,
      warnings: diagnostics.warnings.length,
    };

    factDb.exec('COMMIT');
    globalDb.exec('COMMIT');
    return {
      schema: SNAPSHOT_SCHEMA,
      mode: 'live',
      generated_at: now,
      engagement: { engagement_id: id, created_at: engagement.created_at ?? null },
      watermark,
      nodes: model.nodes,
      edges: model.edges,
      routes,
      tasks,
      conversation: { status: 'unavailable', session_id: null, messages: [] },
      diagnostics: { ...diagnostics, shell_state: shellState },
    };
  } catch (error) {
    rollback(factDb);
    rollback(globalDb);
    if (typeof error.code === 'string' && error.code.startsWith('E_DASHBOARD_')) throw error;
    throw err('E_DASHBOARD_DATABASE', `Dashboard schema/read error: ${error.message}`);
  } finally {
    factDb.close();
    globalDb?.close();
  }
}

function resolveHomePaths(home) {
  let base;
  try { base = realpathSync(home); }
  catch (error) { throw err('E_DASHBOARD_PATH', `Invalid dashboard home: ${error.message}`); }
  const engagementsRoot = resolve(base, 'engagements');
  if (!isWithin(base, engagementsRoot)) throw err('E_DASHBOARD_PATH', 'Engagement path escapes home');
  const globalPath = join(base, 'global.db');
  if (existsSync(globalPath)) assertRealPathWithin(base, globalPath, 'global.db');
  if (existsSync(engagementsRoot)) assertRealPathWithin(base, engagementsRoot, 'Engagement root');
  return { base, engagementsRoot, globalPath };
}

function readEngagement(paths, id, { allowMissing = false } = {}) {
  const dir = resolve(paths.engagementsRoot, id);
  if (!isWithin(paths.engagementsRoot, dir)) throw err('E_DASHBOARD_PATH', 'Engagement path escapes home');
  const factPath = join(dir, 'fact.db');
  if (!existsSync(factPath)) {
    if (allowMissing) return null;
    throw err('E_DASHBOARD_NOT_FOUND', `Engagement not found: ${id}`);
  }
  assertRealPathWithin(paths.base, dir, 'Engagement directory');
  assertRealPathWithin(paths.base, factPath, 'fact.db');
  const db = openReadOnly(factPath);
  try {
    if (!tableNames(db).has('engagements')) throw err('E_DASHBOARD_DATABASE', 'Missing engagements table');
    const engagement = db.prepare('SELECT id, created_at FROM engagements WHERE id = ?').get(id);
    if (!engagement) {
      if (allowMissing) return null;
      throw err('E_DASHBOARD_NOT_FOUND', `Engagement database does not contain requested id: ${id}`);
    }
    return { ...engagement, factPath };
  } catch (error) {
    if (typeof error.code === 'string' && error.code.startsWith('E_DASHBOARD_')) throw error;
    throw err('E_DASHBOARD_DATABASE', `Cannot read engagement database: ${error.message}`);
  } finally {
    db.close();
  }
}

function openReadOnly(path) {
  try {
    const realPath = realpathSync(path);
    const db = new DatabaseSync(realPath, { readOnly: true });
    db.exec('PRAGMA query_only = ON');
    return db;
  } catch (error) {
    throw err('E_DASHBOARD_DATABASE', `Cannot read dashboard database: ${error.message}`);
  }
}
function assertRealPathWithin(root, path, label) {
  try {
    const realRoot = realpathSync(root);
    const realPath = realpathSync(path);
    if (!isWithin(realRoot, realPath)) throw Error('symlink escapes WARROOM_HOME');
  } catch (error) { throw err('E_DASHBOARD_PATH', `${label} path is invalid: ${error.message}`); }
}
function isWithin(root, path) { return path.startsWith(`${root}${sep}`); }
function tableNames(db) { return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)); }
function rowsIfTable(db, tables, table, sql) { return tables.has(table) ? db.prepare(sql).all() : []; }
function emptyDiagnostics() { return { unresolved_refs: 0, ambiguous_refs: 0, warnings: [], counts: {}, truncated: false }; }
function rollback(db) { try { db?.exec('ROLLBACK'); } catch {} }

function projectRoutes(factDb, factTables, globalDb, globalTables, engagementId, now, home, diagnostics) {
  const config = loadEgressMaxAge(home);
  if (config.invalid) diagnostics.warnings.push('Egress freshness configuration is invalid; current pass cannot be established.');
  const routes = rowsIfTable(factDb, factTables, 'jump_routes', `
    SELECT route_id, lease_id, jumphost_id, state, ts FROM jump_routes ORDER BY ts, route_id`);
  return routes.map((route) => {
    const lease = globalTables.has('leases')
      ? globalDb.prepare(`SELECT lease_id, jumphost_id, engagement_id, state, expires_at, heartbeat_at, ts
          FROM leases WHERE lease_id = ? AND engagement_id = ?`).get(route.lease_id, engagementId)
      : null;
    const host = globalTables.has('jumphosts') && route.jumphost_id
      ? globalDb.prepare('SELECT id, addr_v4, addr_v6 FROM jumphosts WHERE id = ?').get(route.jumphost_id)
      : null;
    const check = factTables.has('egress_checks')
      ? factDb.prepare(`SELECT ts, exit_ip, verdict, route_id, jumphost_id, recovered_at
          FROM egress_checks WHERE route_id = ? ORDER BY ts DESC, id DESC LIMIT 1`).get(route.route_id)
      : null;
    const leaseMatches = Boolean(lease && lease.lease_id === route.lease_id
      && lease.engagement_id === engagementId && lease.jumphost_id === route.jumphost_id);
    const expiresAt = lease ? validTime(lease.expires_at) : NaN;
    const leaseActive = leaseMatches && lease.state === 'active'
      && Number.isFinite(expiresAt) && expiresAt > Date.parse(now);
    const checkTime = check ? Date.parse(check.ts) : NaN;
    const leaseTime = lease ? Date.parse(lease.ts) : NaN;
    const ageMs = Date.parse(now) - checkTime;
    const checkCurrent = Boolean(check && leaseActive && route.state === 'active'
      && check.jumphost_id === route.jumphost_id && check.recovered_at == null
      && Number.isFinite(checkTime) && Number.isFinite(leaseTime)
      && checkTime >= leaseTime && checkTime >= Date.parse(route.ts) && checkTime <= Date.parse(now)
      && Number.isFinite(config.maxAgeMs) && ageMs <= config.maxAgeMs);
    const state = route.state ?? 'unknown';
    return {
      route_id: route.route_id,
      jumphost_id: route.jumphost_id ?? null,
      entry_ip: host?.addr_v4 ?? host?.addr_v6 ?? null,
      exit_ip: check?.exit_ip ?? null,
      state,
      lease: {
        state: !leaseMatches ? 'unknown' : lease.state !== 'active' ? lease.state
          : !Number.isFinite(expiresAt) ? 'unknown' : leaseActive ? 'active' : 'expired',
        expires_at: lease?.expires_at ?? null,
        remaining_seconds: leaseMatches && Number.isFinite(expiresAt)
          ? Math.max(0, Math.floor((expiresAt - Date.parse(now)) / 1000)) : null,
      },
      egress: { verdict: check?.verdict ?? 'unknown', checked_at: check?.ts ?? null, current: checkCurrent && check.verdict === 'pass' },
      node_ids: [],
      edge_ids: [],
    };
  });
}
function validTime(value) { const time = Date.parse(value); return Number.isFinite(time) ? time : NaN; }
function loadEgressMaxAge(home) {
  try {
    const config = loadConfig(home);
    return { maxAgeMs: config.egressMaxAgeMin * 60_000 };
  } catch {
    return { maxAgeMs: NaN, invalid: true };
  }
}

function projectTasks(facts, globalDb, globalTables, engagementId, diagnostics) {
  const queue = globalTables.has('command_queue')
    ? globalDb.prepare(`SELECT command_id, task_id, contract, state, ts FROM command_queue WHERE engagement_id = ? ORDER BY ts, command_id`).all(engagementId)
    : [];
  const factByTask = new Map();
  for (const row of facts) {
    if (row.entity_type !== 'task') continue;
    const taskId = typeof row.payload.task_id === 'string' ? row.payload.task_id : row.source_id;
    if (!factByTask.has(taskId)) factByTask.set(taskId, row.payload);
  }
  const tasks = queue.map((row) => {
    const contract = parseObject(row.contract);
    const payload = factByTask.get(row.task_id) ?? {};
    return {
      task_id: row.task_id ?? row.command_id,
      command_id: row.command_id,
      state: taskState(row.state),
      role: safeString(contract.role),
      route_id: safeString(contract.route_id),
      updated_at: row.ts,
    };
  });
  for (const [taskId, payload] of factByTask) {
    if (tasks.some((task) => task.task_id === taskId)) continue;
    diagnostics.warnings.push(`Task fact ${safeString(taskId) ?? 'unknown'} has no command ledger row; omitted from task state.`);
    void payload;
  }
  return tasks;
}
function taskState(value) {
  return ['queued', 'running', 'cancel_requested', 'unknown', 'unresolved', 'done', 'partial', 'failed', 'cancelled', 'confirmed_stopped'].includes(value)
    ? value : 'unknown';
}
function safeString(value) { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120) : null; }
function parseObject(value) {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}
function attachRouteAssociations(routes, nodes, edges) {
  for (const route of routes) {
    const nodeIds = new Set(nodes.filter((node) => node.route_ids.includes(route.route_id)).map((node) => node.id));
    const edgeIds = [];
    for (const edge of edges) {
      if (!edge.route_ids.includes(route.route_id)) continue;
      edgeIds.push(edge.id);
      nodeIds.add(edge.from);
      nodeIds.add(edge.to);
    }
    route.node_ids = [...nodeIds];
    route.edge_ids = edgeIds;
  }
}
function readShellState(db, tables, engagementId) {
  if (!tables.has('shell_state')) return { state: 'unknown', highest_proof: null, current_validity: 'unknown', last_verified_at: null };
  const row = db.prepare(`SELECT highest_proof, current_validity, last_verified_at FROM shell_state
    WHERE engagement_id = ? ORDER BY id DESC LIMIT 1`).get(engagementId);
  return row ? {
    state: 'observed',
    highest_proof: row.highest_proof ?? null,
    current_validity: row.current_validity ?? 'unknown',
    last_verified_at: row.last_verified_at ?? null,
  } : { state: 'unknown', highest_proof: null, current_validity: 'unknown', last_verified_at: null };
}
function readWatermark(db, tables) {
  return { fact_seq: tables.has('fact_seq') ? db.prepare('SELECT COALESCE(MAX(id), 0) AS seq FROM fact_seq').get().seq : null };
}
export { projectFacts, createDemoSnapshot };
