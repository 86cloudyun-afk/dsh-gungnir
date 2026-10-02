import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoSnapshot } from '../packages/warroom-dashboard/src/demo.js';
import { layoutGraph, focusedSubgraph, collapseEvidence, collapseEvidenceGraph, findExactNode, fitNodeLabel, routeSelection, taskSelection, snapshotSummary, messageMatchesSelection, retainSelection } from '../packages/warroom-dashboard/public/graph.js';

test('layout keeps fork, merge, shared route IDs, isolated nodes and stable coordinates', () => {
  const snapshot = createDemoSnapshot();
  const isolated = { ...snapshot.nodes[0], id: 'isolated-node', source_id: 'solo', layer: 2, route_ids: [] };
  snapshot.nodes.push(isolated);
  const first = layoutGraph(snapshot);
  const second = layoutGraph(snapshot);
  assert.equal(first.nodes.length, snapshot.nodes.length);
  assert.equal(first.edges.length, snapshot.edges.length);
  assert.deepEqual(first.nodes.map(({ id, x, y }) => [id, x, y]), second.nodes.map(({ id, x, y }) => [id, x, y]));
  assert.ok(first.nodes.find((node) => node.id === 'isolated-node'));
  assert.ok(first.nodes.find((node) => node.id === 'demo-node:evidence-b').route_ids.length >= 3);
  assert.ok(first.bounds.width > 0 && first.bounds.height > 0);
});

test('all routes are orthogonal and focus computes cycle-safe ancestor/descendant closure', () => {
  const snapshot = createDemoSnapshot();
  snapshot.edges.push({ id: 'cycle-edge', from: 'demo-node:conclusion-a', to: 'demo-node:asset-a', label: 'cycle', kind: 'reference', route_ids: ['demo-route-01'] });
  const layout = layoutGraph(snapshot);
  for (const edge of layout.edges) {
    const points = edge.points;
    assert.ok(points.length >= 2);
    for (let index = 1; index < points.length; index += 1) {
      assert.ok(points[index - 1].x === points[index].x || points[index - 1].y === points[index].y, `diagonal edge ${edge.id}`);
    }
  }
  const focused = focusedSubgraph(snapshot, 'demo-node:asset-a');
  assert.ok(focused.node_ids.includes('demo-node:conclusion-a'));
  assert.ok(focused.node_ids.includes('demo-node:entrance-01'));
  assert.equal(focused.node_ids.length, new Set(focused.node_ids).size);
  assert.ok(focused.route_notes.length >= 4);
  const leftToRight = layoutGraph(snapshot, { direction: 'LR' });
  assert.equal(leftToRight.bounds.direction, 'LR');
  for (const edge of leftToRight.edges) {
    for (let index = 1; index < edge.points.length; index += 1) {
      assert.ok(edge.points[index - 1].x === edge.points[index].x || edge.points[index - 1].y === edge.points[index].y);
    }
  }
  const compactFocus = layoutGraph(snapshot, { direction: 'LR', nodeWidth: 176, nodeHeight: 32, itemGap: 8, rankGap: 208 });
  assert.ok(compactFocus.nodes.every((node) => node.y >= 0 && node.y + node.height <= compactFocus.bounds.height));
});

test('focus combines directed ancestor and descendant closures without sibling branches', () => {
  const snapshot = createDemoSnapshot();
  snapshot.nodes = [
    { ...snapshot.nodes[5], id: 'diamond-root', source_id: 'diamond-root' },
    { ...snapshot.nodes[5], id: 'diamond-left', source_id: 'diamond-left' },
    { ...snapshot.nodes[5], id: 'diamond-right', source_id: 'diamond-right' },
    { ...snapshot.nodes[5], id: 'focus-target', source_id: 'focus-target' },
    { ...snapshot.nodes[5], id: 'shared-descendant', source_id: 'shared-descendant' },
    { ...snapshot.nodes[5], id: 'outside-parent', source_id: 'outside-parent' },
    { ...snapshot.nodes[5], id: 'sibling-branch', source_id: 'sibling-branch' },
  ];
  snapshot.edges = [
    { id: 'root-left', from: 'diamond-root', to: 'diamond-left' },
    { id: 'root-right', from: 'diamond-root', to: 'diamond-right' },
    { id: 'left-target', from: 'diamond-left', to: 'focus-target' },
    { id: 'right-target', from: 'diamond-right', to: 'focus-target' },
    { id: 'target-desc', from: 'focus-target', to: 'shared-descendant' },
    { id: 'other-parent-desc', from: 'outside-parent', to: 'shared-descendant' },
    { id: 'root-sibling', from: 'diamond-root', to: 'sibling-branch' },
  ];
  const result = focusedSubgraph(snapshot, 'focus-target');
  assert.ok(result.node_ids.includes('diamond-root'));
  assert.ok(result.node_ids.includes('diamond-left'));
  assert.ok(result.node_ids.includes('diamond-right'));
  assert.ok(result.node_ids.includes('shared-descendant'));
  assert.ok(!result.node_ids.includes('outside-parent'));
  assert.ok(!result.node_ids.includes('sibling-branch'));
});

test('evidence collapse reports hidden count, shared dependencies and risky summaries', () => {
  const snapshot = createDemoSnapshot();
  const collapsed = collapseEvidence(snapshot, { includeEvidence: false });
  assert.equal(collapsed.hidden_node_count + collapsed.retained_node_count, snapshot.nodes.filter((node) => node.layer === 2).length);
  assert.equal(collapsed.aggregate_nodes.reduce((total, node) => total + node.hidden_node_count, 0), collapsed.hidden_node_count);
  assert.ok(collapsed.route_notes.length >= 4);
  assert.ok(collapsed.anomalies.some((item) => item.state === 'failed'));
  assert.ok(collapsed.anomalies.some((item) => item.state === 'pending'));
});

test('exact source search reports duplicate adapter/type identities instead of choosing one', () => {
  const snapshot = createDemoSnapshot();
  snapshot.nodes.push({ ...snapshot.nodes[0], id: 'other-adapter-copy', adapter_instance: 'other-adapter' });
  const ambiguous = findExactNode(snapshot, snapshot.nodes[0].source_id);
  assert.equal(ambiguous.node, null);
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal(findExactNode(snapshot, 'other-adapter-copy').node.id, 'other-adapter-copy');
  assert.equal(findExactNode(snapshot, 'missing-source').candidates.length, 0);
});

test('global and local label fitting ellipsizes CJK and English while preserving source text', () => {
  const longChinese = '这是一个非常长的中文资产名称需要被限制在节点宽度内';
  const longEnglish = 'A-very-long-asset-name-that-must-not-overflow-the-node';
  for (const fontSize of [16, 20]) {
    for (const label of [longChinese, longEnglish]) {
      const fitted = fitNodeLabel(label, 138, fontSize);
      assert.ok(fitted.endsWith('…'));
      assert.notEqual(fitted, label);
    }
  }
  assert.equal(fitNodeLabel('短名称', 138, 20), '短名称');
});

test('route and task selections use only explicit route/node/edge mappings', () => {
  const snapshot = {
    nodes: [{ id: 'jump', task_ids: [], route_ids: ['r1', 'r2'] }, { id: 'task-node', task_ids: ['t1'], route_ids: [] }],
    edges: [{ id: 'e1', route_ids: ['r1'] }, { id: 'e2', route_ids: ['r2'] }],
    routes: [{ route_id: 'r1', jumphost_id: 'shared', node_ids: ['jump'], edge_ids: ['e1'] }, { route_id: 'r2', jumphost_id: 'shared', node_ids: ['jump'], edge_ids: ['e2'] }],
    tasks: [{ task_id: 't1', route_id: 'r2' }],
  };
  assert.deepEqual(routeSelection(snapshot, 'r1').edge_ids, ['e1']);
  assert.deepEqual(taskSelection(snapshot, 't1').node_ids.sort(), ['jump', 'task-node']);
  assert.deepEqual(taskSelection(snapshot, 't1').edge_ids, ['e2']);
  assert.deepEqual(taskSelection(snapshot, 'unknown').node_ids, []);
  assert.equal(snapshot.routes.filter((route) => route.jumphost_id === 'shared').length, 2);
});

test('summary reports partial totals and independent risks including expired pending route', () => {
  const summary = snapshotSummary({
    nodes: [{ state: 'failed' }, { state: 'pending' }], edges: [], routes: [{ lease: { state: 'expired' }, egress: { current: false } }], tasks: [],
    diagnostics: { truncated: true, unresolved_refs: 3, ambiguous_refs: 2, counts: { nodes: 20, edges: 4, routes: 2, tasks: 1 } },
  });
  assert.equal(summary.partial, true);
  assert.equal(summary.displayed.nodes, 2);
  assert.equal(summary.totals.nodes, 20);
  assert.deepEqual(summary.risks, { failed: 1, pending: 2, expired: 1 });
  assert.equal(snapshotSummary({ nodes: [], edges: [], routes: [], tasks: [], diagnostics: {} }).totals.nodes, null);
});

test('route and task selections match node-only messages through explicit mapped node IDs', () => {
  const message = { node_ids: ['n1'], route_ids: [], task_ids: [] };
  assert.equal(messageMatchesSelection(message, { kind: 'route', id: 'r1', node_ids: ['n1'], edge_ids: [] }), true);
  assert.equal(messageMatchesSelection(message, { kind: 'task', id: 't1', node_ids: ['n1'], edge_ids: [], route_ids: [] }), true);
  assert.equal(messageMatchesSelection({ ...message, node_ids: ['unrelated'] }, { kind: 'route', id: 'r1', node_ids: ['n1'] }), false);
});

test('same-scope refresh retains only still-unique route/task mappings and rebuilds them', () => {
  const oldSnapshot = {
    mode: 'real', engagement: { engagement_id: 'eng-1' },
    nodes: [{ id: 'n1', task_ids: ['t1'] }], edges: [],
    routes: [{ route_id: 'r1', node_ids: ['n1'], edge_ids: ['e-old'] }],
    tasks: [{ task_id: 't1', route_id: 'r1' }],
  };
  const newSnapshot = {
    ...oldSnapshot,
    routes: [{ route_id: 'r1', node_ids: ['n1'], edge_ids: ['e-new'] }],
  };
  assert.deepEqual(retainSelection(oldSnapshot, newSnapshot, { kind: 'route', id: 'r1', node_ids: ['stale'], edge_ids: ['stale'] }), { kind: 'route', id: 'r1', node_ids: ['n1'], edge_ids: ['e-new'] });
  assert.deepEqual(retainSelection(oldSnapshot, newSnapshot, { kind: 'task', id: 't1', node_ids: ['stale'], edge_ids: [], route_ids: [] }), { kind: 'task', id: 't1', node_ids: ['n1'], edge_ids: ['e-new'], route_ids: ['r1'] });
  assert.equal(retainSelection(oldSnapshot, { ...newSnapshot, routes: [] }, { kind: 'route', id: 'r1' }), null);
  assert.equal(retainSelection(oldSnapshot, { ...newSnapshot, tasks: [{ task_id: 't1' }, { task_id: 't1' }] }, { kind: 'task', id: 't1' }), null);
  assert.equal(retainSelection(oldSnapshot, { ...newSnapshot, mode: 'demo' }, { kind: 'route', id: 'r1' }), null);
  assert.equal(retainSelection(oldSnapshot, { ...newSnapshot, engagement: { engagement_id: 'eng-2' } }, { kind: 'route', id: 'r1' }), null);
});

test('collapsed evidence never connects disconnected path segments through a shared aggregate', () => {
  const snapshot = {
    nodes: [
      { id: 'path-a', layer: 1, route_ids: ['r1'] },
      { id: 'evidence-in', layer: 2, label: 'input', source_id: 'source-in', route_ids: ['r1'], state: 'pending' },
      { id: 'evidence-out', layer: 2, label: 'output', source_id: 'source-out', route_ids: ['r2'], state: 'failed' },
      { id: 'path-b', layer: 3, route_ids: ['r2'] },
    ],
    edges: [
      { id: 'a-to-e1', from: 'path-a', to: 'evidence-in', route_ids: ['r1'], kind: 'fact' },
      { id: 'e2-to-b', from: 'evidence-out', to: 'path-b', route_ids: ['r2'], kind: 'reference', risk: 'expired' },
    ],
  };
  const collapsed = collapseEvidenceGraph(snapshot);
  assert.ok(collapsed.nodes.some((node) => node.id === 'evidence-in' && node.label === 'input'));
  assert.ok(collapsed.nodes.some((node) => node.id === 'evidence-out' && node.label === 'output'));
  assert.deepEqual(collapsed.edges.map(({ from, to }) => [from, to]), [['path-a', 'evidence-in'], ['evidence-out', 'path-b']]);
  assert.equal(collapsed.edges.length, snapshot.edges.length);
  assert.deepEqual(collapsed.edges[1].route_ids, ['r2']);
  assert.equal(collapsed.edges[1].risk, 'expired');
  const foldSummary = collapseEvidence(snapshot, { includeEvidence: false });
  assert.equal(foldSummary.hidden_node_count, 0);
  assert.equal(foldSummary.retained_node_count, 2);
  assert.deepEqual(foldSummary.retained_node_ids.sort(), ['evidence-in', 'evidence-out']);
  const reachable = (start, target) => {
    const seen = new Set([start]); const pending = [start];
    while (pending.length) {
      const current = pending.pop();
      for (const edge of collapsed.edges.filter((item) => item.from === current)) {
        if (edge.to === target) return true;
        if (!seen.has(edge.to)) { seen.add(edge.to); pending.push(edge.to); }
      }
    }
    return false;
  };
  assert.equal(reachable('path-a', 'path-b'), false);
});

test('collapsed topology preserves fork, convergence, cycles, disconnected nodes and shared routes', () => {
  const snapshot = {
    nodes: [
      { id: 'fork', layer: 1, route_ids: ['r1', 'r2'] },
      { id: 'ev-a', layer: 2, source_id: 'src-a', route_ids: ['r1'] },
      { id: 'ev-b', layer: 2, source_id: 'src-b', route_ids: ['r2'] },
      { id: 'merge', layer: 3, route_ids: ['r1', 'r2'] },
      { id: 'cycle-a', layer: 2, source_id: 'cycle-a', route_ids: ['r3'] },
      { id: 'cycle-b', layer: 2, source_id: 'cycle-b', route_ids: ['r3'] },
      { id: 'disconnected', layer: 2, source_id: 'isolated', route_ids: [] },
    ],
    edges: [
      { id: 'fork-a', from: 'fork', to: 'ev-a', route_ids: ['r1'] },
      { id: 'fork-b', from: 'fork', to: 'ev-b', route_ids: ['r2'] },
      { id: 'a-merge', from: 'ev-a', to: 'merge', route_ids: ['r1'] },
      { id: 'b-merge', from: 'ev-b', to: 'merge', route_ids: ['r2'] },
      { id: 'cycle-forward', from: 'cycle-a', to: 'cycle-b', route_ids: ['r3'] },
      { id: 'cycle-back', from: 'cycle-b', to: 'cycle-a', route_ids: ['r3'] },
    ],
  };
  const collapsed = collapseEvidenceGraph(snapshot);
  const idMap = new Map(collapsed.nodes.flatMap((node) => (node.aggregate_source_ids || []).map((id) => [id, node.id])));
  assert.equal(idMap.size, 0);
  assert.deepEqual(collapsed.nodes, snapshot.nodes);
  assert.equal(collapsed.edges.length, snapshot.edges.length);
  assert.deepEqual(collapsed.edges.map((edge) => [edge.from, edge.to]), snapshot.edges.map((edge) => [edge.from, edge.to]));
  for (let index = 0; index < snapshot.edges.length; index += 1) assert.deepEqual(collapsed.edges[index].route_ids, snapshot.edges[index].route_ids);
});

test('fold reduces structurally equivalent parallel evidence and large isolated sets', () => {
  const sharedMetadata = { layer: 2, route_ids: ['r1'], task_ids: ['t1'], state: 'pending', highest_proof: 'observed', current_validity: 'stale', risk: 'review' };
  const snapshot = {
    nodes: [
      { id: 'in', layer: 1 },
      { id: 'e1', source_id: 'source-1', label: 'Evidence 1', ...sharedMetadata },
      { id: 'e2', source_id: 'source-2', label: 'Evidence 2', ...sharedMetadata },
      { id: 'out', layer: 3 },
    ],
    edges: [
      { id: 'in-e1', from: 'in', to: 'e1', kind: 'fact', route_ids: ['r1'] },
      { id: 'in-e2', from: 'in', to: 'e2', kind: 'fact', route_ids: ['r1'] },
      { id: 'e1-out', from: 'e1', to: 'out', kind: 'fact', route_ids: ['r1'] },
      { id: 'e2-out', from: 'e2', to: 'out', kind: 'fact', route_ids: ['r1'] },
    ],
    routes: [{ route_id: 'r1', jumphost_id: 'jh', lease: { state: 'expired' }, egress: { verdict: 'pass', current: false } }],
  };
  const folded = collapseEvidenceGraph(snapshot);
  const aggregates = folded.nodes.filter((node) => node.kind === 'evidence-aggregate');
  assert.equal(aggregates.length, 1);
  assert.equal(folded.nodes.length, snapshot.nodes.length - 1);
  assert.deepEqual(aggregates[0].aggregate_source_ids.sort(), ['e1', 'e2']);
  assert.deepEqual(aggregates[0].aggregate_sources.sort(), ['source-1', 'source-2']);
  assert.equal(aggregates[0].hidden_node_count, 2);
  assert.equal(aggregates[0].state, 'pending');
  assert.deepEqual(folded.edges.map((edge) => [edge.from, edge.to]), [
    ['in', aggregates[0].id], ['in', aggregates[0].id], [aggregates[0].id, 'out'], [aggregates[0].id, 'out'],
  ]);
  const foldSummary = collapseEvidence(snapshot, { includeEvidence: false });
  assert.equal(foldSummary.hidden_node_count, 2);
  assert.equal(foldSummary.retained_node_count, 0);
  assert.equal(foldSummary.route_notes.length, snapshot.routes.length);
  assert.deepEqual(foldSummary.anomalies, collapseEvidence(snapshot, { includeEvidence: true }).anomalies);

  const many = { nodes: Array.from({ length: 240 }, (_, index) => ({ id: `isolated-${index}`, source_id: `src-${index}`, layer: 2, state: 'unknown', route_ids: ['shared'], task_ids: [] })), edges: [] };
  const foldedMany = collapseEvidenceGraph(many);
  assert.equal(foldedMany.nodes.length, 1);
  assert.equal(foldedMany.nodes[0].hidden_node_count, 240);
  assert.equal(foldedMany.nodes[0].aggregate_source_ids.length, 240);
});

test('same undirected component does not merge evidence with different directed boundaries', () => {
  const snapshot = {
    nodes: [
      { id: 'a', layer: 1 }, { id: 'shared-parent', layer: 1 },
      { id: 'e1', source_id: 's1', layer: 2, route_ids: ['r'], task_ids: [], state: 'unknown' },
      { id: 'e2', source_id: 's2', layer: 2, route_ids: ['r'], task_ids: [], state: 'unknown' },
      { id: 'b', layer: 3 },
    ],
    edges: [
      { id: 'a-in', from: 'a', to: 'e1' },
      { id: 'shared-to-e1', from: 'shared-parent', to: 'e1' },
      { id: 'shared-to-e2', from: 'shared-parent', to: 'e2' },
      { id: 'e2-out', from: 'e2', to: 'b' },
    ],
  };
  const folded = collapseEvidenceGraph(snapshot);
  const e1 = folded.nodes.find((node) => node.id === 'e1');
  const e2 = folded.nodes.find((node) => node.id === 'e2');
  assert.ok(e1 && e2);
  assert.notEqual(e1.id, e2.id);
  const reachable = (start, target) => {
    const seen = new Set([start]); const pending = [start];
    while (pending.length) {
      const current = pending.pop();
      for (const edge of folded.edges.filter((item) => item.from === current)) {
        if (edge.to === target) return true;
        if (!seen.has(edge.to)) { seen.add(edge.to); pending.push(edge.to); }
      }
    }
    return false;
  };
  assert.equal(reachable('a', 'b'), false);
});

test('fold signature keeps per-edge direction, kind, route IDs and risk metadata distinct', () => {
  const snapshot = {
    nodes: [
      { id: 'p', layer: 1 }, { id: 'e1', layer: 2, route_ids: ['r1', 'r2'], task_ids: [], state: 'verified' },
      { id: 'e2', layer: 2, route_ids: ['r1', 'r2'], task_ids: [], state: 'verified' }, { id: 'q', layer: 3 },
    ],
    edges: [
      { id: 'p-e1', from: 'p', to: 'e1', kind: 'explicit', route_ids: ['r1'], risk: 'low' },
      { id: 'e1-q', from: 'e1', to: 'q', kind: 'reference', route_ids: ['r2'] },
      { id: 'p-e2', from: 'p', to: 'e2', kind: 'reference', route_ids: ['r2'] },
      { id: 'e2-q', from: 'e2', to: 'q', kind: 'explicit', route_ids: ['r1'], risk: 'low' },
    ],
  };
  const folded = collapseEvidenceGraph(snapshot);
  assert.ok(folded.nodes.some((node) => node.id === 'e1'));
  assert.ok(folded.nodes.some((node) => node.id === 'e2'));
  assert.equal(folded.nodes.filter((node) => node.kind === 'evidence-aggregate').length, 0);

  const stateMismatch = {
    ...snapshot,
    edges: snapshot.edges.map((edge) => ({ ...edge, route_ids: ['r1'], kind: 'explicit' })),
    nodes: snapshot.nodes.map((node) => node.id === 'e2' ? { ...node, state: 'pending' } : node),
  };
  assert.equal(collapseEvidenceGraph(stateMismatch).nodes.filter((node) => node.kind === 'evidence-aggregate').length, 0);
});
