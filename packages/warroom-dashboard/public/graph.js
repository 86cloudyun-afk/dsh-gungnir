const NODE_WIDTH = 190;
const NODE_HEIGHT = 42;
const X_GAP = 60;
const Y_GAP = 112;
const PAD = 48;

export function layoutGraph(snapshot, options = {}) {
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const edges = Array.isArray(snapshot?.edges) ? snapshot.edges : [];
  const nodeWidth = options.nodeWidth || NODE_WIDTH;
  const nodeHeight = options.nodeHeight || NODE_HEIGHT;
  const groups = Array.from({ length: 5 }, () => []);
  for (const node of nodes) groups[clampLayer(node.layer)].push(node);
  for (const group of groups) group.sort((left, right) => left.id.localeCompare(right.id));
  const maxCount = Math.max(1, ...groups.map((group) => group.length));
  const direction = options.direction === 'LR' ? 'LR' : 'TB';
  const rankGap = Math.max(direction === 'LR' ? nodeWidth + 28 : Y_GAP, options.rankGap || Y_GAP);
  const itemGap = direction === 'LR' ? (options.itemGap ?? 22) : X_GAP;
  const width = options.width || (direction === 'LR'
    ? PAD * 2 + 4 * rankGap + nodeWidth
    : Math.max(680, maxCount * (nodeWidth + itemGap) - itemGap + PAD * 2 + 120));
  const height = direction === 'LR'
    ? PAD * 2 + maxCount * nodeHeight + Math.max(0, maxCount - 1) * itemGap
    : PAD * 2 + 4 * rankGap + nodeHeight;
  const positioned = groups.flatMap((group, layer) => {
    if (direction === 'LR') {
      const rowHeight = group.length * nodeHeight + Math.max(0, group.length - 1) * itemGap;
      const startY = Math.max(PAD, (height - rowHeight) / 2);
      return group.map((node, index) => ({
        ...node,
        x: Math.round(PAD + layer * rankGap),
        y: Math.round(startY + index * (nodeHeight + itemGap)),
        width: nodeWidth,
        height: nodeHeight,
        route_ids: [...(node.route_ids || [])],
      }));
    }
    const rowWidth = group.length * nodeWidth + Math.max(0, group.length - 1) * itemGap;
    const start = Math.max(PAD + 120, (width - rowWidth) / 2);
    return group.map((node, index) => ({
      ...node,
      x: Math.round(start + index * (nodeWidth + itemGap)),
      y: Math.round(PAD + (4 - layer) * rankGap),
      width: nodeWidth,
      height: nodeHeight,
      route_ids: [...(node.route_ids || [])],
    }));
  });
  const byId = new Map(positioned.map((node) => [node.id, node]));
  const laidEdges = edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to)).map((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (direction === 'LR') {
      const start = { x: from.x + from.width, y: from.y + from.height / 2 };
      const end = { x: to.x, y: to.y + to.height / 2 };
      const middleX = Math.round((start.x + end.x) / 2);
      return { ...edge, points: [start, { x: middleX, y: start.y }, { x: middleX, y: end.y }, end] };
    }
    const start = { x: from.x + from.width / 2, y: from.y };
    const end = { x: to.x + to.width / 2, y: to.y + to.height };
    const middleY = Math.round((start.y + end.y) / 2);
    return { ...edge, points: [start, { x: start.x, y: middleY }, { x: end.x, y: middleY }, end] };
  });
  return {
    nodes: positioned,
    edges: laidEdges,
    bounds: { x: 0, y: 0, width, height, direction, rankGap },
    route_notes: routeNotes(snapshot),
    anomalies: anomalies(snapshot),
  };
}

export function focusedSubgraph(snapshot, selectedId) {
  const nodeIds = new Set((snapshot?.nodes || []).map((node) => node.id));
  if (!nodeIds.has(selectedId)) return { node_ids: [], edge_ids: [], route_notes: routeNotes(snapshot) };
  const incoming = new Map([...nodeIds].map((id) => [id, new Set()]));
  const outgoing = new Map([...nodeIds].map((id) => [id, new Set()]));
  for (const edge of snapshot.edges || []) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    outgoing.get(edge.from).add(edge.to);
    incoming.get(edge.to).add(edge.from);
  }
  const included = new Set([selectedId]);
  walkClosure(selectedId, incoming, included);
  walkClosure(selectedId, outgoing, included);
  return {
    node_ids: [...included].sort(),
    edge_ids: (snapshot.edges || []).filter((edge) => included.has(edge.from) && included.has(edge.to)).map((edge) => edge.id),
    route_notes: routeNotes(snapshot),
  };
}

function walkClosure(start, adjacency, included) {
  const visited = new Set([start]);
  const pending = [start];
  while (pending.length) {
    const current = pending.pop();
    for (const neighbor of adjacency.get(current) || []) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      included.add(neighbor);
      pending.push(neighbor);
    }
  }
}

export function collapseEvidence(snapshot, { includeEvidence = true } = {}) {
  const hidden = includeEvidence ? [] : (snapshot.nodes || []).filter((node) => node.layer === 2);
  const shared = new Map();
  for (const node of hidden) {
    for (const routeId of node.route_ids || []) shared.set(routeId, (shared.get(routeId) || 0) + 1);
  }
  const aggregate = hidden.length ? [{
    id: 'aggregate:evidence', kind: 'evidence-aggregate', label: `证据折叠 · ${hidden.length} 项`,
    hidden_node_count: hidden.length, shared_route_ids: [...shared.keys()].sort(),
    shared_dependencies: [...shared].filter(([, count]) => count > 1).map(([route_id, count]) => ({ route_id, count })),
  }] : [];
  return { hidden_node_count: hidden.length, aggregate_nodes: aggregate, route_notes: routeNotes(snapshot), anomalies: anomalies(snapshot) };
}

export function findExactNode(snapshot, query) {
  if (typeof query !== 'string' || !query) return { node: null, candidates: [] };
  const nodes = snapshot?.nodes || [];
  const byNodeId = nodes.find((node) => node.id === query);
  if (byNodeId) return { node: byNodeId, candidates: [byNodeId], match: 'node-id' };
  const bySource = nodes.filter((node) => node.source_id === query);
  if (bySource.length) return { node: bySource.length === 1 ? bySource[0] : null, candidates: bySource, match: 'source-id' };
  const byTask = nodes.filter((node) => node.task_ids?.includes(query));
  if (byTask.length) return { node: byTask.length === 1 ? byTask[0] : null, candidates: byTask, match: 'task-id' };
  const routeIds = (snapshot?.routes || []).filter((route) => route.route_id === query || route.jumphost_id === query).map((route) => route.route_id);
  const byRoute = nodes.filter((node) => node.route_ids?.some((id) => routeIds.includes(id)) || node.source_id === query);
  if (byRoute.length) return { node: byRoute.length === 1 ? byRoute[0] : null, candidates: byRoute, match: 'route-id' };
  return { node: null, candidates: [], match: null };
}

export function fitNodeLabel(value, maxWidth, fontSize) {
  const text = String(value || '');
  const widthOf = (character) => /[\u2e80-\u9fff\uf900-\ufaff]/u.test(character) ? fontSize : fontSize * 0.58;
  if ([...text].reduce((sum, character) => sum + widthOf(character), 0) <= maxWidth) return text;
  const available = Math.max(0, maxWidth - fontSize);
  let width = 0;
  let result = '';
  for (const character of text) {
    const next = widthOf(character);
    if (width + next > available) break;
    result += character;
    width += next;
  }
  return `${result}…`;
}

export function routeSelection(snapshot, routeId) {
  const route = (snapshot?.routes || []).find((item) => item.route_id === routeId);
  if (!route) return { route: null, candidates: [], node_ids: [], edge_ids: [] };
  return { route, candidates: [route], node_ids: [...(route.node_ids || [])], edge_ids: [...(route.edge_ids || [])] };
}

export function taskSelection(snapshot, taskId) {
  const tasks = (snapshot?.tasks || []).filter((item) => item.task_id === taskId || item.id === taskId);
  if (tasks.length !== 1) return { task: null, candidates: tasks, route_ids: [], node_ids: [], edge_ids: [] };
  const task = tasks[0];
  const routeId = task.route_id;
  const route = routeId ? routeSelection(snapshot, routeId) : null;
  const nodes = (snapshot?.nodes || []).filter((node) => node.task_ids?.includes(taskId));
  return { task, candidates: tasks, route_ids: route?.route ? [routeId] : [], node_ids: [...new Set([...nodes.map((node) => node.id), ...(route?.node_ids || [])])], edge_ids: route?.edge_ids || [] };
}

export function snapshotSummary(snapshot) {
  const diagnostics = snapshot?.diagnostics || {};
  const counts = diagnostics.counts || {};
  const displayed = { nodes: snapshot?.nodes?.length || 0, edges: snapshot?.edges?.length || 0, routes: snapshot?.routes?.length || 0, tasks: snapshot?.tasks?.length || 0 };
  const totals = Object.fromEntries(Object.keys(displayed).map((key) => [key, Number.isFinite(counts[key]) ? counts[key] : null]));
  const risks = { failed: 0, pending: 0, expired: 0 };
  for (const node of snapshot?.nodes || []) {
    if (node.state === 'failed') risks.failed += 1;
    if (node.state === 'pending') risks.pending += 1;
  }
  for (const route of snapshot?.routes || []) {
    if (route.egress?.verdict === 'fail' || route.state === 'failed') risks.failed += 1;
    if (route.egress?.verdict === 'pending' || route.egress?.current === false) risks.pending += 1;
    if (route.lease?.state === 'expired') risks.expired += 1;
  }
  return { partial: diagnostics.truncated === true, displayed, totals, unresolved: Number(diagnostics.unresolved_refs) || 0, ambiguous: Number(diagnostics.ambiguous_refs) || 0, risks };
}

function routeNotes(snapshot) {
  return (snapshot?.routes || []).map((route) => ({
    route_id: route.route_id, jumphost_id: route.jumphost_id, entry_ip: route.entry_ip || '未知', exit_ip: route.exit_ip || '未知',
    lease_state: route.lease?.state || 'unknown', expires_at: route.lease?.expires_at || '未知',
    egress_verdict: route.egress?.verdict || 'unknown', egress_current: route.egress?.current === true,
  }));
}

function anomalies(snapshot) {
  const items = (snapshot?.routes || []).flatMap((route) => {
    const risks = [];
    if (route.egress?.verdict === 'fail' || route.state === 'failed') risks.push('failed');
    if (route.egress?.verdict === 'pending' || route.egress?.current === false) risks.push('pending');
    if (route.lease?.state === 'expired') risks.push('expired');
    return risks.map((state) => ({ route_id: route.route_id, state, verdict: route.egress?.verdict || 'unknown' }));
  });
  for (const node of snapshot?.nodes || []) if (node.state === 'failed' || node.state === 'pending') items.push({ node_id: node.id, state: node.state });
  return items;
}

function clampLayer(layer) { return Number.isInteger(layer) ? Math.max(0, Math.min(4, layer)) : 2; }
