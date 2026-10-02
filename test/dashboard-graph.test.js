import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoSnapshot } from '../packages/warroom-dashboard/src/demo.js';
import { layoutGraph, focusedSubgraph, collapseEvidence, findExactNode } from '../packages/warroom-dashboard/public/graph.js';

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
  assert.equal(collapsed.hidden_node_count, snapshot.nodes.filter((node) => node.layer === 2).length);
  assert.ok(collapsed.aggregate_nodes.some((node) => node.kind === 'evidence-aggregate'));
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
