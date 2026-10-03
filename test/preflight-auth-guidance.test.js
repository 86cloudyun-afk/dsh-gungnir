// Missing authorization stays blocked; guidance must use the trusted host boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';

test('missing authorization preflight blocks execution and directs trusted host/operator setup', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'wr-auth-guidance-'));
  const broker = new Broker({ home, adapter: new FakeAdapter() });
  t.after(() => {
    for (const { db } of broker.engagements.values()) db.close();
    broker.global.close(); rmSync(home, { recursive: true, force: true });
  });
  const result = broker.preflight('eng_missing_fixture');
  assert.equal(result.verdict, 'blocked');
  const detail = result.checks.find((x) => x.dim === 'engagement' && x.name === '战役存在').detail;
  assert.match(detail, /可信宿主|操作员/);
  assert.match(detail, /CLI `warroom engage`/);
  assert.match(detail, /已有 engagement_id/);
  assert.doesNotMatch(detail, /warroom_engage/);
  assert.equal(broker.adapter.tasks.size, 0);
  assert.equal(broker._eng('eng_missing_fixture').db.prepare('SELECT count(*) AS n FROM engagements').get().n, 0);
});
