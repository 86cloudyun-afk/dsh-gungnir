// Report metadata redaction: source_id / IOC ref / remediation ref must pass the vault
// redactor (ADR-001 D7). Payload-only scrub left secrets embedded in human-readable IDs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness } from '../packages/warroom-core/src/testing.js';

const SECRET = 'MetaSrc-P@ss-2026-plain';

function engagementWithSecretSourceId() {
  const h = harness();
  h.broker.secrets.put(SECRET, { label: 'meta-src' });
  const ex = h.broker.execute({
    ...h.base,
    command_id: 'meta-src-1',
    contract: h.contract({
      fake_members: [{
        entity_type: 'vuln',
        source_id: `sqli-${SECRET}`,
        revision_no: 1,
        content_hash: 'h-meta',
        payload: { title: 'sqli', remediation: 'parameterize queries' },
      }],
    }),
  });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  return h;
}

test('markdown impact / facts / remediation redact vault secrets inside source_id', () => {
  const h = engagementWithSecretSourceId();
  const { markdown } = h.broker.buildReport(h.eng.engagement_id);
  assert.equal(markdown.includes(SECRET), false, 'markdown must not leak source_id secret');
  assert.match(markdown, /\[REDACTED:meta-src\]/);
  assert.match(markdown, /影响面摘要/);
  assert.match(markdown, /修复建议/);
});

test('JSON facts.source_id and derived refs redact vault secrets', () => {
  const h = engagementWithSecretSourceId();
  const exported = h.broker.exportReport(h.eng.engagement_id, { format: 'json' });
  const json = JSON.parse(readFileSync(exported.paths.json, 'utf8'));
  const blob = JSON.stringify(json);
  assert.equal(blob.includes(SECRET), false, 'JSON report must not leak source_id secret');
  const vuln = json.facts.effective.find((f) => f.entity_type === 'vuln');
  assert.ok(vuln);
  assert.match(vuln.source_id, /\[REDACTED:meta-src\]/);
  assert.ok(json.impact.severity.reasons.every((r) => !r.text.includes(SECRET)));
  assert.ok(json.remediation.items.every((i) => !String(i.ref).includes(SECRET)));
});

test('HTML export inherits markdown metadata redaction', () => {
  const h = engagementWithSecretSourceId();
  const exported = h.broker.exportReport(h.eng.engagement_id, { format: 'html' });
  const html = readFileSync(exported.paths.html, 'utf8');
  assert.equal(html.includes(SECRET), false, 'HTML report must not leak source_id secret');
  assert.match(html, /\[REDACTED:meta-src\]/);
});

test('payload-only secret still redacted alongside metadata scrub', () => {
  const h = harness();
  h.broker.secrets.put(SECRET, { label: 'meta-src' });
  const ex = h.broker.execute({
    ...h.base,
    command_id: 'meta-src-payload',
    contract: h.contract({
      fake_members: [{
        entity_type: 'credential',
        source_id: 'cred-clean',
        revision_no: 1,
        content_hash: 'h-cred',
        payload: { password: SECRET, service: 'ssh' },
      }],
    }),
  });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  const { markdown } = h.broker.buildReport(h.eng.engagement_id);
  assert.equal(markdown.includes(SECRET), false);
  assert.match(markdown, /cred-clean/);
  assert.match(markdown, /\[REDACTED:meta-src\]/);
});

test('mermaid redacts vault secrets before special-char escaping (Codex P1)', () => {
  // Mermaid safe() turns `|` into a space; if redaction runs after that, vault
  // exact-match fails and almost the whole credential leaks into the graph.
  const SECRET_PIPE = 'hunter2|meta';
  const h = harness();
  h.broker.secrets.put(SECRET_PIPE, { label: 'pipe-cred' });
  const src = `sqli-${SECRET_PIPE}`;
  const ex = h.broker.execute({
    ...h.base,
    command_id: 'meta-mermaid-1',
    contract: h.contract({
      fake_members: [
        {
          entity_type: 'vuln',
          source_id: src,
          revision_no: 1,
          content_hash: 'h-pipe-v',
          payload: { title: 'sqli' },
        },
        {
          entity_type: 'shell',
          source_id: 'shell-pipe',
          revision_no: 1,
          content_hash: 'h-pipe-s',
          payload: { achieved_via: src },
        },
      ],
    }),
  });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  const { markdown } = h.broker.buildReport(h.eng.engagement_id);
  assert.match(markdown, /攻击路径拓扑/);
  assert.match(markdown, /```mermaid/);
  assert.equal(markdown.includes(SECRET_PIPE), false, 'mermaid must not keep raw pipe-secret');
  assert.equal(markdown.includes('hunter2'), false, 'partial credential after safe() must not remain');
  assert.match(markdown, /\[REDACTED:pipe-cred\]/);
});

test('JSON impact counts distinct assets before source_id redaction (Codex P2)', () => {
  // Two different secrets sharing one vault label must not collapse to one asset
  // when redaction runs before buildImpact's Set-based counting.
  const A = 'AssetSecret-AAA-2026';
  const B = 'AssetSecret-BBB-2026';
  const h = harness();
  h.broker.secrets.put(A, { label: 'asset' });
  h.broker.secrets.put(B, { label: 'asset' });
  const ex = h.broker.execute({
    ...h.base,
    command_id: 'meta-impact-1',
    contract: h.contract({
      fake_members: [
        { entity_type: 'asset', source_id: `host-${A}`, revision_no: 1, content_hash: 'h-a', payload: { ip: '10.0.0.1' } },
        { entity_type: 'asset', source_id: `host-${B}`, revision_no: 1, content_hash: 'h-b', payload: { ip: '10.0.0.2' } },
      ],
    }),
  });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  const exported = h.broker.exportReport(h.eng.engagement_id, { format: 'json' });
  const json = JSON.parse(readFileSync(exported.paths.json, 'utf8'));
  assert.equal(json.impact.scope.assets, 2, 'distinct assets must survive shared-label redaction');
  const blob = JSON.stringify(json);
  assert.equal(blob.includes(A), false);
  assert.equal(blob.includes(B), false);
});
