// Real responder boundary; executor modules only return inert synthetic receipts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(t, { receipt = {}, useCommand = false, useFixture = false, probeReceipt = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wr-outcome-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const job = { protocol: 'gungnir-bridge/1', external_id: 'synthetic-job', role: 'recon', background: true,
    contract: { task_id: 'synthetic-job', generation: '1:1:1', targets: [], resources: [], wire_cost: 0 } };
  mkdirSync(join(root, 'outbox'));
  writeFileSync(join(root, 'outbox', 'synthetic-job.job.json'), JSON.stringify(job));
  const runMarker = join(root, 'run-called');
  const modulePath = join(root, 'executor.mjs');
  const output = { generation: '1:1:1', external_id: 'synthetic-job', members: [], resources: [], ...receipt };
  const runBody = `appendFileSync(${JSON.stringify(runMarker)}, 'called\\n'); return ${JSON.stringify(output)};`;
  const code = useCommand
    ? `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(output))}));`
    : `import { appendFileSync } from 'node:fs'; export default {
        async run(job) { ${runBody} }
      };`;
  writeFileSync(modulePath, code);
  const fixtureDir = join(root, 'fixtures');
  if (useFixture) {
    mkdirSync(fixtureDir);
    writeFileSync(join(fixtureDir, 'synthetic-job.facts.json'), JSON.stringify({
      generation: '1:1:1', external_id: 'synthetic-job', members: [], ...receipt,
    }));
    writeFileSync(join(fixtureDir, 'synthetic-job.probes.json'), JSON.stringify({
      generation: '1:1:1', external_id: 'synthetic-job', resources: [], ...probeReceipt,
    }));
  }
  const run = () => spawnSync(process.execPath, ['scripts/dsh-bridge-responder.mjs', '--root', root,
    '--once', ...(useFixture ? ['--mode', 'fixture', '--fixture', fixtureDir]
      : ['--executor', useCommand ? 'executors/dsh-redteam-executor.mjs' : modulePath])], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, GUNGNIR_EXECUTOR_CMD: JSON.stringify([process.execPath, modulePath]) },
  });
  const read = (dir, suffix) => JSON.parse(readFileSync(join(root, dir, `synthetic-job${suffix}`), 'utf8'));
  const noReceipts = () => {
    assert.equal(existsSync(join(root, 'inbox', 'synthetic-job.facts.json')), false);
    assert.equal(existsSync(join(root, 'inbox', 'synthetic-job.probes.json')), false);
    assert.notEqual(read('claims', '.json').state, 'completed');
  };
  return { root, run, read, noReceipts, runMarker };
}

test('explicit incomplete executor reports never become done or empty successful receipts', async (t) => {
  for (const receipt of [{ state: 'failed' }, { state: 'incomplete' }, { state: 'partial' },
    { state: 'unknown' }, { state: null }, { status: 'blocked' }, { ok: false },
    { error: { code: 'MISSING_TOOL', message: 'no channel available' } }]) {
    await t.test(JSON.stringify(receipt), (t) => {
      const f = fixture(t, { receipt });
      const r = f.run();
      assert.equal(r.status, 0, r.stderr);
      assert.equal(f.read('inbox', '.status.json').state, 'unknown');
      assert.match(r.stderr, /E_EXECUTOR_INCOMPLETE/);
      f.noReceipts();
      f.run();
      assert.equal(f.read('inbox', '.status.json').state, 'unknown', 'restart cannot republish done');
      assert.equal(readFileSync(f.runMarker, 'utf8'), 'called\n', 'restart must not rerun a rejected source');
      f.noReceipts();
    });
  }
});

test('configured command wrapper preserves rejection of structured tool/capability failure', (t) => {
  const f = fixture(t, { useCommand: true, receipt: { state: 'failed', ok: false,
    error: { code: 'MISSING_TOOL', message: 'orchestration tools only' } } });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.read('inbox', '.status.json').state, 'unknown');
  assert.match(r.stderr, /E_EXECUTOR_INCOMPLETE/);
  f.noReceipts();
});

test('successful legacy and explicit completion receipts remain compatible', async (t) => {
  for (const useCommand of [false, true]) {
    for (const receipt of [{}, { state: 'done', status: 'success', ok: true, error: null, errors: [] }]) {
      await t.test(JSON.stringify({ useCommand, receipt }), (t) => {
        const f = fixture(t, { useCommand, receipt });
        const r = f.run();
        assert.equal(r.status, 0, r.stderr);
        const source = f.read('inbox', '.status.json');
        assert.equal(source.state, 'done');
        const facts = f.read('inbox', '.facts.json');
        assert.equal(facts.external_id, 'synthetic-job');
        assert.equal(facts.generation, '1:1:1');
        assert.equal(facts.event_seq, source.event_seq);
        assert.deepEqual(facts.members, []);
      });
    }
  }
});

test('incomplete receipt arrays are rejected before command normalization can fabricate success', async (t) => {
  for (const useCommand of [false, true]) {
    for (const receipt of [{ members: undefined }, { members: null }, { members: {} },
      { resources: undefined }, { resources: null }, { resources: {} }]) {
      await t.test(JSON.stringify({ useCommand, receipt }), (t) => {
        const f = fixture(t, { useCommand, receipt });
        const r = f.run();
        assert.equal(r.status, 0, r.stderr);
        assert.equal(f.read('inbox', '.status.json').state, 'unknown');
        f.noReceipts();
      });
    }
  }
});

test('outcome admission does not relax result identity/generation binding', async (t) => {
  for (const useCommand of [false, true]) {
    for (const receipt of [{ generation: '2:1:1' }, { generation: undefined }, { external_id: 'other-job' }]) {
      await t.test(JSON.stringify({ useCommand, receipt }), (t) => {
        const f = fixture(t, { useCommand, receipt });
        f.run();
        assert.equal(f.read('inbox', '.status.json').state, 'unknown');
        f.noReceipts();
      });
    }
  }
});

test('rejected result diagnostics persist with source identity and are not republished as done', (t) => {
  const f = fixture(t, { receipt: { state: 'incomplete' } });
  f.run();
  const source = f.read('inbox', '.status.json');
  assert.equal(source.state, 'unknown');
  assert.deepEqual(source.diagnostic, {
    code: 'E_EXECUTOR_INCOMPLETE', phase: 'result', external_id: 'synthetic-job', generation: '1:1:1', role: 'recon',
  });
  assert.deepEqual(f.read('claims', '.json').diagnostic, source.diagnostic);
  f.run();
  assert.deepEqual(f.read('inbox', '.status.json').diagnostic, source.diagnostic);
  f.noReceipts();
});

test('fixture mapping cannot erase failures or manufacture missing source arrays', async (t) => {
  for (const options of [{ receipt: { state: 'failed' } }, { receipt: { ok: false } },
    { probeReceipt: { status: 'incomplete' } }, { probeReceipt: { error: 'missing tool' } },
    { receipt: { members: undefined } }, { receipt: { members: null } },
    { probeReceipt: { resources: undefined } }, { probeReceipt: { resources: null } }]) {
    await t.test(JSON.stringify(options), (t) => {
      const f = fixture(t, { useFixture: true, ...options });
      const r = f.run();
      assert.equal(r.status, 0, r.stderr);
      assert.equal(f.read('inbox', '.status.json').state, 'unknown');
      f.noReceipts();
      f.run();
      assert.equal(f.read('inbox', '.status.json').state, 'unknown');
    });
  }
});

test('legal fixture source envelopes keep source identity and completion', async (t) => {
  for (const options of [{}, { receipt: { state: 'done' }, probeReceipt: { status: 'success' } }]) {
    await t.test(JSON.stringify(options), (t) => {
      const f = fixture(t, { useFixture: true, ...options });
      const r = f.run();
      assert.equal(r.status, 0, r.stderr);
      const source = f.read('inbox', '.status.json');
      assert.equal(source.state, 'done');
      for (const suffix of ['.facts.json', '.probes.json']) {
        const receipt = f.read('inbox', suffix);
        assert.equal(receipt.external_id, 'synthetic-job');
        assert.equal(receipt.generation, '1:1:1');
        assert.equal(receipt.event_seq, source.event_seq);
      }
    });
  }
});
