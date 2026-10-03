import { createHash } from 'node:crypto';
import { redact } from '../../warroom-core/src/redactor.js';

const clean = (value, max = 240) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max)
  : null;
const tupleKey = (adapter, type, source) => JSON.stringify([adapter, type, source]);
const stableId = (adapter, type, source) => `fact:${createHash('sha256').update(tupleKey(adapter, type, source)).digest('hex').slice(0, 24)}`;

export function normalizeDisplayText(value, max = 240) {
  if (typeof value !== 'string') return null;
  return redact(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) || null;
}

export function projectFacts(rows, diagnostics) {
  const facts = decodeRows(rows, diagnostics);
  const active = facts.filter((row) => row.active === 1);
  const byTriple = new Map(active.map((row) => [tupleKey(row.adapter_instance, row.entity_type, row.source_id), row]));
  const bySource = groupBy(active, (row) => row.source_id);
  const nodes = active.map((row) => projectNode(row));
  const edges = [];

  function add(fromRef, toRef, label, kind, routeIds = [], sourceAdapter = null) {
    const from = resolveReference(fromRef, active, byTriple, bySource, diagnostics, sourceAdapter);
    const to = resolveReference(toRef, active, byTriple, bySource, diagnostics, sourceAdapter);
    if (!from || !to || from === to) return;
    const edgeId = `edge:${edges.length}:${from}:${to}`;
    edges.push({ id: edgeId, from, to, label: normalizeDisplayText(label) || '引用', kind, route_ids: cleanStrings(routeIds) });
  }

  for (const row of active) {
    const payload = row.payload;
    const self = { adapter_instance: row.adapter_instance, entity_type: row.entity_type, source_id: row.source_id };
    for (const step of asArray(payload.steps)) {
      if (step && step.from != null && step.to != null) add(step.from, step.to, step.via || 'chain-step', 'explicit', step.route_ids, row.adapter_instance);
    }
    const path = payload.path ?? payload.chain;
    if (Array.isArray(path) && path.length > 1) {
      for (let index = 0; index < path.length - 1; index += 1) add(path[index], path[index + 1], 'path', 'explicit', payload.route_ids, row.adapter_instance);
    }
    if (payload.achieved_via != null) add(payload.achieved_via, self, 'achieved_via', 'explicit', payload.route_ids, row.adapter_instance);
    for (const edge of asArray(payload.edges)) {
      if (edge && edge.from != null && edge.to != null) add(edge.from, edge.to, edge.label || edge.via, edge.kind === 'explicit' ? 'explicit' : 'reference', edge.route_ids, row.adapter_instance);
      else if (edge?.to != null) add(self, edge.to, edge.label, edge.kind === 'explicit' ? 'explicit' : 'reference', edge.route_ids, row.adapter_instance);
    }
    for (const ref of asArray(payload.refs)) add(self, ref?.to ?? ref, ref?.label, ref?.kind === 'explicit' ? 'explicit' : 'reference', ref?.route_ids, row.adapter_instance);
    for (const field of ['asset', 'target', 'host', 'via', 'source_ref', 'unlocks']) {
      if (payload[field] != null) add(payload[field], self, field, 'reference', payload.route_ids, row.adapter_instance);
    }
  }

  for (const node of nodes) node._membership = new Set(node.route_ids);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    for (const routeId of edge.route_ids) {
      nodeById.get(edge.from)?._membership.add(routeId);
      nodeById.get(edge.to)?._membership.add(routeId);
    }
  }
  for (const node of nodes) {
    node.route_ids = [...node._membership];
    delete node._membership;
  }
  return { nodes, edges, facts };
}

function decodeRows(rows, diagnostics) {
  const decoded = [];
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload ?? '{}');
      decoded.push({ ...row, payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {} });
    } catch {
      diagnostics.warnings.push(`Malformed payload on fact ${row.id}`);
    }
  }
  return decoded;
}

function projectNode(row) {
  const payload = row.payload;
  const layer = Number(payload.layer);
  return {
    id: stableId(row.adapter_instance, row.entity_type, row.source_id),
    source_id: clean(row.source_id),
    adapter_instance: clean(row.adapter_instance),
    entity_type: clean(row.entity_type),
    label: normalizeDisplayText(payload.label) || normalizeDisplayText(row.source_id),
    layer: Number.isInteger(layer) ? Math.max(0, Math.min(4, layer)) : layerFor(row.entity_type),
    state: stateOf(payload.state),
    route_ids: cleanStrings(payload.route_ids),
    task_ids: cleanStrings(payload.task_ids),
    highest_proof: null,
    current_validity: null,
    updated_at: clean(row.ts, 40),
  };
}

function resolveReference(ref, active, byTriple, bySource, diagnostics, sourceAdapter) {
  const parsed = parseReference(ref);
  if (!parsed) {
    diagnostics.unresolved_refs += 1;
    return null;
  }
  const explicitAdapter = parsed.adapter_instance;
  let candidates;
  if (explicitAdapter && parsed.entity_type) {
    const key = tupleKey(explicitAdapter, parsed.entity_type, parsed.source_id);
    const found = byTriple.has(key);
    if (!found) diagnostics.unresolved_refs += 1;
    return found ? stableId(explicitAdapter, parsed.entity_type, parsed.source_id) : null;
  }
  const typeMatches = (row) => !parsed.entity_type || row.entity_type === parsed.entity_type;
  const allCandidates = (bySource.get(parsed.source_id) || []).filter(typeMatches);
  if (explicitAdapter) candidates = allCandidates.filter((row) => row.adapter_instance === explicitAdapter);
  else if (sourceAdapter) {
    const sameAdapter = allCandidates.filter((row) => row.adapter_instance === sourceAdapter);
    if (sameAdapter.length > 1) { diagnostics.ambiguous_refs += 1; return null; }
    candidates = sameAdapter.length === 1 ? sameAdapter : allCandidates;
  } else candidates = allCandidates;
  if (candidates.length === 1) {
    const row = candidates[0];
    return stableId(row.adapter_instance, row.entity_type, row.source_id);
  }
  if (candidates.length > 1) diagnostics.ambiguous_refs += 1;
  else diagnostics.unresolved_refs += 1;
  return null;
}

function parseReference(ref) {
  if (typeof ref === 'string' && ref.length) return { source_id: ref };
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const source = ref.source_id ?? ref.source_ref ?? ref.id;
  if (typeof source !== 'string' || !source) return null;
  return {
    source_id: source,
    adapter_instance: typeof ref.adapter_instance === 'string' ? ref.adapter_instance : null,
    entity_type: typeof ref.entity_type === 'string' ? ref.entity_type : null,
  };
}

function groupBy(values, keyOf) {
  const result = new Map();
  for (const value of values) {
    const key = keyOf(value);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(value);
  }
  return result;
}
function asArray(value) { return Array.isArray(value) ? value : []; }
function cleanStrings(value) { return Array.isArray(value) ? value.filter((item) => typeof item === 'string').map((item) => clean(item, 120)).filter(Boolean) : []; }
function stateOf(value) { return ['verified', 'pending', 'failed'].includes(value) ? value : 'unknown'; }
function layerFor(type) {
  return ({ jumphost: 0, asset: 1, domain: 1, target: 1, evidence: 2, vuln: 2, credential: 2, chain: 3, conclusion: 4, session: 4, shell: 4, persistence: 4 })[type] ?? 2;
}
