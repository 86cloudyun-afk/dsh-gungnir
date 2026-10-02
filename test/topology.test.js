// 攻击路径拓扑：有引用才画边；无引用只给节点并如实提示。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness } from '../packages/warroom-core/src/testing.js';
import { buildTopology, toMermaid } from '../packages/warroom-core/src/topology.js';

test('steps 引用成边；无引用的弱点被如实计数', () => {
  const facts = [
    { entity_type: 'asset', source_id: '10.0.0.5', payload: JSON.stringify({ note: 'web' }) },
    { entity_type: 'vuln', source_id: 'CVE-2026-1111', payload: JSON.stringify({ asset: '10.0.0.5' }) },
    { entity_type: 'chain', source_id: 'chain-1', payload: JSON.stringify({
      steps: [{ from: '10.0.0.5', to: 'CVE-2026-1111', via: '暴露面' }, { from: 'CVE-2026-1111', to: 'shell-1', via: 'RCE' }],
    }) },
    { entity_type: 'shell', source_id: 'shell-1', payload: JSON.stringify({ achieved_via: 'chain-1' }) },
    { entity_type: 'vuln', source_id: 'CVE-2026-9999', payload: JSON.stringify({ sev: 'low' }) },  // 无引用
  ];
  const t = buildTopology(facts);
  assert.equal(t.nodes.length, 5);
  assert.equal(t.edges.length, 3, JSON.stringify(t.edges));
  assert.equal(t.unexplained, 1, '无引用的弱点应被计数');

  const mm = toMermaid(t);
  assert.match(mm, /```mermaid/);
  assert.match(mm, /flowchart LR/);
  assert.match(mm, /暴露面/);
  assert.match(mm, /RCE/);
});

test('path 数组连续成边', () => {
  const facts = [
    { entity_type: 'asset', source_id: 'a', payload: '{}' },
    { entity_type: 'asset', source_id: 'b', payload: '{}' },
    { entity_type: 'asset', source_id: 'c', payload: '{}' },
    { entity_type: 'chain', source_id: 'p', payload: JSON.stringify({ path: ['a', 'b', 'c'] }) },
  ];
  const t = buildTopology(facts);
  assert.equal(t.edges.length, 2);
});

test('报告收录拓扑段：有边才出段，且 JSON 含 topology', () => {
  const h = harness();
  const ex = h.broker.execute({
    ...h.base, command_id: 'topo-1',
    contract: h.contract({
      fake_members: [
        { entity_type: 'asset', source_id: '10.0.0.9', revision_no: 1, content_hash: 'h1', payload: { note: 'web' } },
        { entity_type: 'vuln', source_id: 'CVE-2026-2222', revision_no: 1, content_hash: 'h2', payload: { asset: '10.0.0.9' } },
        { entity_type: 'chain', source_id: 'chain-topo', revision_no: 1, content_hash: 'h3',
          payload: { steps: [{ from: '10.0.0.9', to: 'CVE-2026-2222', via: '未认证接口' }] } },
      ],
    }),
  });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));

  const r = h.broker.exportReport(h.eng.engagement_id, { format: 'both' });
  const md = readFileSync(r.paths.markdown, 'utf8');
  assert.match(md, /## 攻击路径拓扑/);
  assert.match(md, /```mermaid/);
  assert.match(md, /未认证接口/);

  const json = JSON.parse(readFileSync(r.paths.json, 'utf8'));
  assert.ok(json.topology.edges.length >= 1, JSON.stringify(json.topology));
  assert.equal(json.topology.nodes.length, 3);
  assert.equal(json.topology.edges[0].via, '未认证接口', '显式链条步骤应优先于推断引用');
});

test('无边时不出现拓扑段（不画空图）', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'topo-2', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  const r = h.broker.exportReport(h.eng.engagement_id, { format: 'md' });
  const md = readFileSync(r.paths.markdown, 'utf8');
  assert.equal(md.includes('攻击路径拓扑'), false);
});
