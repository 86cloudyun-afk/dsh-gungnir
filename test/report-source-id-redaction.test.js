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
