function makeNode(id, label, layer, state = 'verified', routeIds = []) {
  return {
    id: `demo-node:${id}`, source_id: `demo-${id}`, adapter_instance: 'demo-adapter',
    entity_type: layer === 0 ? 'jumphost' : layer === 1 ? 'asset' : layer === 2 ? 'evidence' : layer === 3 ? 'chain' : 'conclusion',
    label, layer, state, route_ids: [...routeIds], task_ids: [], highest_proof: null,
    current_validity: 'unknown', updated_at: null,
  };
}

export function createDemoSnapshot() {
  const routes = [
    route('demo-route-01', 'demo-host-01', '192.0.2.11', '198.51.100.11', 'pass', 1),
    route('demo-route-02', 'demo-host-02', '192.0.2.12', '198.51.100.12', 'pending', 1),
    route('demo-route-03', 'demo-host-03', '192.0.2.13', '198.51.100.13', 'fail', 1),
    route('demo-route-04', 'demo-host-04', '192.0.2.14', '198.51.100.14', 'pass', 1),
  ];
  const ids = routes.map((item) => item.route_id);
  const nodes = [
    makeNode('entrance-01', '入口 / 跳板 1', 0, 'verified', [ids[0]]),
    makeNode('entrance-02', '入口 / 跳板 2', 0, 'pending', [ids[1]]),
    makeNode('entrance-03', '入口 / 跳板 3', 0, 'failed', [ids[2]]),
    makeNode('entrance-04', '入口 / 跳板 4', 0, 'verified', [ids[3]]),
    makeNode('asset-a', '资产 A', 1, 'verified', [ids[0], ids[1]]),
    makeNode('asset-b', '资产 B', 1, 'pending', [ids[1], ids[2]]),
    makeNode('asset-c', '资产 C', 1, 'verified', [ids[0], ids[3]]),
    makeNode('asset-d', '资产 D', 1, 'unknown', [ids[2], ids[3]]),
    makeNode('target-a', '目标 A', 1, 'verified', [ids[0], ids[2]]),
    makeNode('target-b', '目标 B', 1, 'pending', [ids[1], ids[3]]),
    makeNode('evidence-a', '证据 A', 2, 'verified', [ids[0], ids[1]]),
    makeNode('evidence-b', '共享证据 B', 2, 'verified', [ids[1], ids[2], ids[3]]),
    makeNode('evidence-c', '证据 C', 2, 'failed', [ids[0], ids[3]]),
    makeNode('evidence-unknown', '未知事实', 2, 'unknown', [ids[2]]),
    makeNode('vuln-a', '弱点 A', 2, 'pending', [ids[0], ids[1]]),
    makeNode('vuln-b', '弱点 B', 2, 'verified', [ids[2], ids[3]]),
    makeNode('chain-a', '链路分支 A', 3, 'verified', [ids[0], ids[1]]),
    makeNode('chain-b', '链路分支 B', 3, 'pending', [ids[1], ids[2]]),
    makeNode('chain-merge', '链路汇合', 3, 'failed', [ids[0], ids[1], ids[2], ids[3]]),
    makeNode('conclusion-a', '结论 A', 4, 'verified', [ids[0], ids[2]]),
    makeNode('conclusion-b', '结论 B', 4, 'unknown', [ids[1], ids[3]]),
  ];
  const edges = [
    edge(nodes, 'entrance-01', 'asset-a', ids[0], '入口关联'), edge(nodes, 'entrance-02', 'asset-a', ids[1], '入口关联'),
    edge(nodes, 'entrance-02', 'asset-b', ids[1], '入口关联'), edge(nodes, 'entrance-03', 'asset-b', ids[2], '入口关联'),
    edge(nodes, 'entrance-04', 'asset-c', ids[3], '入口关联'), edge(nodes, 'asset-a', 'target-a', ids[0], '目标引用'),
    edge(nodes, 'asset-b', 'target-a', ids[2], '共享目标'), edge(nodes, 'asset-c', 'target-b', ids[3], '目标引用'),
    edge(nodes, 'asset-d', 'target-b', ids[3], '目标引用'), edge(nodes, 'target-a', 'evidence-a', ids[0], '采集证据'),
    edge(nodes, 'target-a', 'evidence-b', ids[1], '共享证据'), edge(nodes, 'target-b', 'evidence-b', ids[3], '共享证据'),
    edge(nodes, 'asset-b', 'evidence-unknown', ids[2], '待核验引用'), edge(nodes, 'evidence-a', 'vuln-a', ids[1], '证据支持'),
    edge(nodes, 'evidence-b', 'vuln-b', ids[2], '证据支持'), edge(nodes, 'vuln-a', 'chain-a', ids[0], '路径分支'),
    edge(nodes, 'vuln-a', 'chain-b', ids[1], '路径分支'), edge(nodes, 'vuln-b', 'chain-b', ids[2], '路径分支'),
    edge(nodes, 'chain-a', 'chain-merge', ids[0], '汇合'), edge(nodes, 'chain-b', 'chain-merge', ids[1], '汇合'),
    edge(nodes, 'evidence-c', 'chain-merge', ids[3], '共享证据汇入'), edge(nodes, 'chain-merge', 'conclusion-a', ids[2], '结论'),
    edge(nodes, 'chain-merge', 'conclusion-b', ids[3], '结论'),
  ];
  for (const item of routes) {
    const routeEdges = edges.filter((itemEdge) => itemEdge.route_ids.includes(item.route_id));
    const nodeIds = new Set();
    for (const routeEdge of routeEdges) { nodeIds.add(routeEdge.from); nodeIds.add(routeEdge.to); }
    for (const node of nodes) if (node.route_ids.includes(item.route_id)) nodeIds.add(node.id);
    item.node_ids = [...nodeIds];
    item.edge_ids = routeEdges.map((itemEdge) => itemEdge.id);
  }
  const messages = [
    message('demo-msg-01', 'user', '从入口 1 查看资产 A。', ['entrance-01', 'asset-a'], [ids[0]]),
    message('demo-msg-02', 'assistant', '入口 1 与入口 2 在资产 A 汇合。', ['entrance-01', 'entrance-02', 'asset-a'], ids.slice(0, 2)),
    message('demo-msg-03', 'user', '展开共享证据 B 到链路汇合。', ['evidence-b', 'chain-merge'], ids.slice(1)),
    message('demo-msg-04', 'assistant', '结论仍有未知事实需要核验。', ['evidence-unknown', 'conclusion-b'], [ids[2], ids[3]]),
  ];
  return {
    schema: 'gungnir-dashboard/1', mode: 'demo', generated_at: '2026-10-03T00:00:00.000Z',
    engagement: { engagement_id: 'demo-engagement-001', created_at: null }, watermark: { fact_seq: null },
    nodes, edges, routes, tasks: [],
    conversation: { status: 'demo', session_id: 'demo-session-001', messages },
    diagnostics: { unresolved_refs: 0, ambiguous_refs: 0, warnings: ['Synthetic example data; RFC 5737 documentation addresses only.'], counts: { nodes: nodes.length, edges: edges.length, routes: routes.length, tasks: 0, warnings: 1 }, truncated: false },
  };
}
function route(routeId, hostId, entry, exit, verdict, leaseHours) {
  const expires = new Date(Date.UTC(2026, 9, 3, leaseHours)).toISOString();
  return { route_id: routeId, jumphost_id: hostId, entry_ip: entry, exit_ip: exit, state: 'active', lease: { state: 'active', expires_at: expires, remaining_seconds: leaseHours * 3600 }, egress: { verdict, checked_at: '2026-10-03T00:00:00.000Z', current: verdict === 'pass' }, node_ids: [], edge_ids: [] };
}
function edge(nodes, from, to, routeId, label) {
  const lookup = new Map(nodes.map((node) => [node.source_id.slice(5), node]));
  return { id: `demo-edge-${from}-${to}-${routeId}`, from: lookup.get(from).id, to: lookup.get(to).id, label, kind: 'explicit', route_ids: [routeId] };
}
function message(id, role, text, sourceIds, routeIds) {
  return { id, role, text, created_at: '2026-10-03T00:00:00.000Z', node_ids: sourceIds.map((sourceId) => `demo-node:${sourceId}`), route_ids: routeIds, task_ids: [] };
}
