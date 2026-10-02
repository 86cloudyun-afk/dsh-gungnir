import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { openEngagementDb, openGlobalDb } from '../packages/warroom-core/src/db.js';
import { createDashboardHandler, startDashboardServer } from '../packages/warroom-dashboard/src/server.js';

// synthetic-example: official sample-style values exercise the redaction boundary; no real credentials.

function homeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-server-'));
  const home = join(root, 'home'); mkdirSync(home);
  const global = openGlobalDb(home); global.close();
  const db = openEngagementDb(join(home, 'engagements', 'eng-1'));
  db.prepare(`INSERT INTO engagements (id,target_scope,window_start,window_end,allowed_means,action_class_limit,rhythm,auth_version,auth_object,auth_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('eng-1','{}','','','','readonly','restricted',1,'{}','h','2026-10-03T00:00:00Z');
  db.prepare(`INSERT INTO fact_members (adapter_instance,entity_type,source_id,revision_no,content_hash,payload,active,ts) VALUES (?,?,?,?,?,?,?,?)`).run('a','asset','node-1',1,'h',JSON.stringify({ label: 'visible node' }),1,'2026-10-03T00:00:00Z');
  db.close(); return { root, home };
}
const fetchJson = async (url, init) => { const response = await fetch(url, init); return { response, body: await response.json() }; };

test('local handler distinguishes no home, opt-in demo, writes, and unexpected host', async () => {
  const handler = createDashboardHandler({});
  const demo = await handler(new Request('http://127.0.0.1/api/demo'));
  assert.equal((await demo.json()).mode, 'demo');
  const missing = await handler(new Request('http://127.0.0.1/api/engagements'));
  assert.deepEqual(await missing.json(), { engagements: [] });
  assert.equal((await handler(new Request('http://127.0.0.1/api/demo', { method: 'POST' }))).status, 405);
  assert.equal((await handler(new Request('http://evil.example/api/demo', { headers: { host: 'evil.example' } }))).status, 403);
  assert.equal((await handler(new Request('http://127.0.0.1/api/../package.json'))).status, 404);
});

test('server fences loopback origin and exposes API/static reads with managed close', async () => {
  const f = homeFixture();
  try {
    const running = await startDashboardServer({ home: f.home, host: '127.0.0.1', port: 0 });
    try {
      assert(running.url.startsWith('http://127.0.0.1:'));
      const base = new URL(running.url).origin;
      const engagements = await fetchJson(`${base}/api/engagements`);
      assert.equal(engagements.response.status, 200);
      assert.equal(engagements.body.engagements[0].engagement_id, 'eng-1');
      assert.equal((await fetch(`${base}/api/demo`, { method: 'POST' })).status, 405);
      assert.equal((await fetch(`${base}/api/demo`, { headers: { origin: 'http://127.0.0.1:1' } })).status, 403);
      assert.equal((await fetch(`${base}/../../package.json`)).status, 404);
    } finally { await running.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('snapshot keeps graph available without a session and reads conversation only after explicit selection', async () => {
  const f = homeFixture();
  const conversationProvider = {
    async listSessions() { return [{ id: 's1', title: 'One' }, { id: 's2', title: 'Two' }]; },
    async readMessages(id) { assert.equal(id, 's1'); return [{ id: 'm1', role: 'user', text: 'see node-1 sk-abcdefghijklmnopqrstuvwxyz012345 ghp_ABCDEFGHIJKLMNOPQRSTUVWX AKIAIOSFODNN7EXAMPLE Bearer abcdefghijklmnopqrstuv token=abc1234567890123456789', node_ids: ['node-1', 'unknown'] }]; },
  };
  const handler = createDashboardHandler({ home: f.home, conversationProvider });
  try {
    const sessions = await (await handler(new Request('http://127.0.0.1/api/sessions'))).json();
    assert.equal(sessions.sessions.length, 2);
    const overview = await (await handler(new Request('http://127.0.0.1/api/snapshot?engagement=eng-1'))).json();
    assert.equal(overview.nodes.length, 1);
    assert.equal(overview.conversation.status, 'unavailable');
    assert.deepEqual(overview.conversation.messages, []);
    const selected = await (await handler(new Request('http://127.0.0.1/api/snapshot?engagement=eng-1&session=s1'))).json();
    assert.equal(selected.conversation.status, 'connected');
    assert.deepEqual(selected.conversation.messages[0].node_ids, [selected.nodes[0].id]);
    for (const secret of ['sk-abcdefghijklmnopqrstuvwxyz012345', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWX', 'AKIAIOSFODNN7EXAMPLE', 'Bearer abcdefghijklmnopqrstuv', 'abc1234567890123456789']) assert(!JSON.stringify(selected).includes(secret));
    assert(selected.conversation.messages[0].text.includes('[REDACTED:openai-key]'));
    const otherVisible = await (await handler(new Request('http://127.0.0.1/api/snapshot?engagement=eng-1&session=s2'))).json();
    assert.equal(otherVisible.conversation.status, 'unavailable');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('conversation reports message and text truncation and exact source ID links only when unique', async () => {
  const f = homeFixture();
  const provider = {
    async listSessions() { return [{ id: 's1', title: 'One' }]; },
    async readMessages() { return Array.from({ length: 205 }, (_, index) => ({ id: `m${index}`, role: 'user', text: index ? 'x'.repeat(4100) : 'node-1' })); },
  };
  try {
    const response = await createDashboardHandler({ home: f.home, conversationProvider: provider })(new Request('http://127.0.0.1/api/snapshot?engagement=eng-1&session=s1'));
    const value = await response.json();
    assert.equal(value.conversation.messages.length, 200);
    assert.equal(value.diagnostics.counts.conversation_messages_total, 205);
    assert.equal(value.diagnostics.counts.conversation_messages_returned, 200);
    assert.equal(value.diagnostics.counts.conversation_text_truncated, 199);
    assert.equal(value.diagnostics.truncated, true);
    assert(value.diagnostics.warnings.some((warning) => warning.includes('truncated')));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('source failures stay explicit and bad home is never replaced by demo', async () => {
  const badHome = await createDashboardHandler({ home: '/path/that/does/not/exist' })(new Request('http://127.0.0.1/api/engagements'));
  assert.equal(badHome.status, 500);
  assert.equal((await badHome.json()).error.code, 'E_DASHBOARD_PATH');
  const f = homeFixture();
  const handler = createDashboardHandler({ home: f.home, conversationProvider: { listSessions: async () => [{ id: 's1', title: 'One' }], readMessages: async () => { throw new Error('secret error detail'); } } });
  try {
    const snapshot = await (await handler(new Request('http://127.0.0.1/api/snapshot?engagement=eng-1&session=s1'))).json();
    assert.equal(snapshot.conversation.status, 'unavailable');
    assert(!JSON.stringify(snapshot).includes('secret error detail'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('CLI validates arguments, serves the page, and shuts down on SIGTERM', async () => {
  const help = spawnSync(process.execPath, ['bin/dashboard.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /GUNGNIR/);
  const invalid = spawnSync(process.execPath, ['bin/dashboard.mjs', '--port', 'bad'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2); assert.match(invalid.stderr, /--port/);
  const f = homeFixture();
  const child = spawn(process.execPath, ['bin/dashboard.mjs', '--home', f.home, '--port', '0'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const line = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`CLI did not start: ${output}`)), 4000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = output.match(/GUNGNIR 战图已启动：(http:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`CLI exited before startup (${code})`)); });
    });
    assert.match(await (await fetch(line)).text(), /GUNGNIR/);
    child.kill('SIGTERM');
    const exit = await new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    assert.equal(exit, 0);
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
    rmSync(f.root, { recursive: true, force: true });
  }
});
