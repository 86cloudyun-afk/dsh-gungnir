import test from 'node:test';
import assert from 'node:assert/strict';
import { projectFacts } from '../packages/warroom-dashboard/src/model.js';
import { normalizeConversationMessages } from '../packages/warroom-dashboard/src/conversation.js';
import { collapseEvidenceGraph, findExactNode } from '../packages/warroom-dashboard/public/graph.js';

test('evidence folding preserves distinct evidence edge labels', () => {
  const snapshot = {
    nodes: [
      { id: 'parent', layer: 1, route_ids: [], task_ids: [], state: 'unknown' },
      { id: 'evidence-a', layer: 2, route_ids: [], task_ids: [], state: 'unknown' },
      { id: 'evidence-b', layer: 2, route_ids: [], task_ids: [], state: 'unknown' },
    ],
    edges: [
      { id: 'edge-a', from: 'parent', to: 'evidence-a', label: 'supports', kind: 'reference', route_ids: [] },
      { id: 'edge-b', from: 'parent', to: 'evidence-b', label: 'contradicts', kind: 'reference', route_ids: [] },
    ],
  };
  const folded = collapseEvidenceGraph(snapshot);
  assert.equal(folded.nodes.filter((node) => node.kind === 'evidence-aggregate').length, 0);
  assert.deepEqual(folded.nodes.map((node) => node.id).sort(), ['evidence-a', 'evidence-b', 'parent']);
});

test('conversation window keeps the latest 200 messages in chronological order', () => {
  const messages = Array.from({ length: 205 }, (_, index) => ({ id: `m${index}`, role: 'user', text: `message ${index}` }));
  const result = normalizeConversationMessages(messages, { nodes: [], routes: [], tasks: [] });
  assert.equal(result.messages.length, 200);
  assert.equal(result.messages[0].id, 'm5');
  assert.equal(result.messages.at(-1).id, 'm204');
  assert.equal(result.total_count, 205);
  assert.equal(result.truncated, true);
});

test('projected source identity keeps full source strings for IDs and exact lookup', () => {
  const prefix = 'source-' + 'x'.repeat(260);
  const sourceA = `${prefix}-A`;
  const sourceB = `${prefix}-B`;
  const snapshot = projectFacts([
    { adapter_instance: 'adapter-A', entity_type: 'asset', source_id: sourceA, active: 1, payload: '{}' },
    { adapter_instance: 'adapter-A', entity_type: 'asset', source_id: sourceB, active: 1, payload: '{}' },
  ], { warnings: [], unresolved_refs: 0, ambiguous_refs: 0 });
  const bySourceA = findExactNode(snapshot, sourceA);
  const bySourceB = findExactNode(snapshot, sourceB);
  assert.equal(new Set(snapshot.nodes.map((node) => node.id)).size, 2);
  assert.equal(new Set(snapshot.nodes.map((node) => node.source_id)).size, 2);
  assert.equal(bySourceA.node?.source_id, sourceA);
  assert.equal(bySourceB.node?.source_id, sourceB);
});

test('projected source identity preserves control characters for exact lookup without aliasing spaces', () => {
  const sourceA = 'part\none';
  const sourceB = 'part one';
  const snapshot = projectFacts([sourceA, sourceB].map((source_id) => ({
    adapter_instance: 'adapter-A', entity_type: 'asset', source_id, active: 1, payload: '{}',
  })), { warnings: [], unresolved_refs: 0, ambiguous_refs: 0 });
  assert.equal(snapshot.nodes[0].source_id, sourceA);
  assert.equal(findExactNode(snapshot, sourceA).node?.id, snapshot.nodes[0].id);
  assert.equal(findExactNode(snapshot, sourceB).node?.id, snapshot.nodes[1].id);
  assert.notEqual(snapshot.nodes[0].id, snapshot.nodes[1].id);
  assert.equal(snapshot.nodes[0].label, 'part one');
});
