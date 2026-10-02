import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEngagementDb, openGlobalDb } from '../packages/warroom-core/src/db.js';
import { apply, inject, name } from '../packages/warroom-dashboard/src/dsh-entry.mjs';

// synthetic-example: official sample-style values exercise the redaction boundary; no real credentials.

function homeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-native-')); const home = join(root, 'home'); mkdirSync(home);
  openGlobalDb(home).close(); const db = openEngagementDb(join(home, 'engagements', 'eng-1'));
  db.prepare(`INSERT INTO engagements (id,target_scope,window_start,window_end,allowed_means,action_class_limit,rhythm,auth_version,auth_object,auth_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('eng-1','{}','','','','readonly','restricted',1,'{}','h','2026-10-03T00:00:00Z'); db.close();
  return { root, home };
}
function makeHost({ home, visible = ['s1'], bindings = { s1: 'eng-1' }, pageRecords = [] } = {}) {
  const calls = []; const routes = new Map(); const effects = []; const childDisposers = []; let disposed = false;
  const root = {
    webServer: { register(route) {
      if (!['exact', 'prefix'].includes(route.kind) || route.path.endsWith('/')) throw new TypeError('invalid native WebRoute contract');
      routes.set(`${route.kind}:${route.path}`, route); return () => routes.delete(`${route.kind}:${route.path}`);
    } },
    connection: { rpc: { handle(channel, fn) { calls.push({ channel, fn }); return async () => { disposed = true; }; } } },
    sessionController: {
      async list(request, signal) { assert.deepEqual(request, {}); if (signal.aborted) throw signal.reason; return { items: visible.map((sessionId) => ({ sessionId })) }; },
      async inspect(sessionId, signal) { assert.equal(sessionId, 's1'); if (signal.aborted) throw signal.reason; return { events: pageRecords.map((record) => record.event) }; },
      async page(request, signal) { if (signal.aborted) throw signal.reason; return { records: pageRecords, hasMore: false }; },
    },
    effect(fn) { effects.push(fn); return fn(); },
  };
  const ctx = { ...root, root, inject(services, callback) {
    assert.deepEqual(services, ['connection']);
    const connectionCtx = { root, connection: root.connection, effect(fn) { childDisposers.push(fn()); } };
    return callback(connectionCtx);
  } };
  const dispose = apply(ctx, { home, sessionBindings: bindings });
  return { ctx, calls, routes, effects, get disposed() { return disposed; }, async dispose() {
    for (const cleanup of childDisposers.splice(0).reverse()) await cleanup?.();
    await dispose();
  } };
}

test('native routes only deliver static assets with opaque-origin CSP and CORS', async () => {
  assert.equal(name, 'gungnir-dashboard');
  assert.deepEqual(inject, ['webServer', 'connection', 'sessionController']);
  const f = homeFixture(); const host = makeHost({ home: f.home });
  const route = host.routes.get('prefix:/gungnir-dashboard');
  assert(route);
  const response = { headers: {}, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body; } };
  await route.handler({ method: 'GET', url: '/gungnir-dashboard/', headers: { host: 'localhost' } }, response);
  assert.match(String(response.headers['content-security-policy']), /connect-src 'none'/);
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.match(String(response.body), /GUNGNIR/);
  const missing = { headers: {}, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body; } };
  route.handler({ method: 'GET', url: '/gungnir-dashboard/unknown.js' }, missing);
  assert.equal(missing.status, 404);
  assert.equal(host.calls[0].channel, '/warroom-dashboard');
  await host.dispose(); assert.equal(host.disposed, true); rmSync(f.root, { recursive: true, force: true });
});

test('native RPC validates visible fixed binding every time and returns ConnectionRpcResult', async () => {
  const f = homeFixture(); const host = makeHost({ home: f.home }); const rpc = host.calls[0].fn;
  const ok = await rpc('snapshot', { sessionId: 's1', engagementId: 'eng-1' }, new AbortController().signal, {});
  assert.equal(ok.ok, true); assert.equal(ok.value.engagement.engagement_id, 'eng-1');
  const denied = await rpc('snapshot', { sessionId: 's2', engagementId: 'eng-1' }, new AbortController().signal, {});
  assert.equal(denied.ok, false); assert.equal(denied.error.code, 'E_DASHBOARD_SCOPE');
  const mismatch = await rpc('snapshot', { sessionId: 's1', engagementId: 'eng-2' }, new AbortController().signal, {});
  assert.equal(mismatch.ok, false); assert.equal(mismatch.error.code, 'E_DASHBOARD_SCOPE');
  assert.deepEqual((await rpc('sessions', { sessionId: 's1' }, new AbortController().signal, {})).value, { sessions: [{ id: 's1', title: 's1' }] });
  rmSync(f.root, { recursive: true, force: true });
});

test('native RPC disposer follows injected child unload and permits reinjection', async () => {
  const f = homeFixture(); const registered = []; const unregistered = []; const childUnloads = [];
  const root = {
    webServer: { register() { return async () => {}; } },
    connection: { rpc: { handle(channel, handler) {
      assert.equal(channel, '/warroom-dashboard');
      registered.push(handler);
      return async () => { unregistered.push(handler); };
    } } },
    sessionController: { async list() { return { items: [{ sessionId: 's1' }] }; } },
    effect(factory) { return factory(); },
  };
  const makeContext = () => ({
    ...root,
    root,
    effect(factory) { return factory(); },
    inject(_services, callback) {
      const childDisposers = [];
      callback({ root, connection: root.connection, effect(factory) { childDisposers.push(factory()); } });
      childUnloads.push(async () => { for (const dispose of childDisposers.reverse()) await dispose?.(); });
    },
  });
  const first = apply(makeContext(), { home: f.home, sessionBindings: { s1: 'eng-1' } });
  assert.equal(registered.length, 1);
  await childUnloads[0]();
  assert.equal(unregistered.length, 1);
  await first();
  await first();
  assert.equal(unregistered.length, 1);
  const second = apply(makeContext(), { home: f.home, sessionBindings: { s1: 'eng-1' } });
  assert.equal(registered.length, 2);
  await childUnloads[1]();
  await second();
  await second();
  assert.equal(unregistered.length, 2);
  rmSync(f.root, { recursive: true, force: true });
});

test('native cold read parses human and committed assistant text only, and cancellation is respected', async () => {
  const records = [
    { type: 'event', event: { type: 'user/message', seq: 1, time: 1790985600000, data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'node-1' }] } } },
    { type: 'event', event: { type: 'user/message', seq: 2, time: 'x', data: { id: 'synth', role: 'user', source: { kind: 'skill' }, content: [{ type: 'text', text: 'ignore' }] } } },
    { type: 'event', event: { type: 'assistant/message', seq: 3, time: 1790985660000, data: { message: { id: 'a1', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'done sk-abcdefghijklmnopqrstuvwxyz012345 token=abc1234567890123456789' }, { type: 'tool-call', name: 'secret-tool' }] } } } },
    { type: 'event', event: { type: 'assistant/attempt', seq: 4, time: 'x', data: { stream: [{ type: 'text', text: 'attempt' }] } } },
    { type: 'event', event: { type: 'assistant/message', seq: 5, time: 1790985720000, data: { message: { id: 'a2', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: `${'x'.repeat(4100)} sk-abcdefghijklmnopqrstuvwxyz012345` }] } } } },
  ];
  const f = homeFixture(); const host = makeHost({ home: f.home, pageRecords: records }); const rpc = host.calls[0].fn;
  const result = await rpc('snapshot', { sessionId: 's1', engagementId: 'eng-1' }, new AbortController().signal, {});
  assert.deepEqual(result.value.conversation.messages.map(({ role }) => role), ['user', 'assistant', 'assistant']);
  assert(!JSON.stringify(result).includes('secret-tool'));
  for (const secret of ['sk-abcdefghijklmnopqrstuvwxyz012345', 'abc1234567890123456789']) assert(!JSON.stringify(result).includes(secret));
  assert.equal(result.value.conversation.messages[0].created_at, new Date(1790985600000).toISOString());
  assert.equal(result.value.diagnostics.counts.conversation_messages_total, 3);
  assert.equal(result.value.diagnostics.counts.conversation_text_truncated, 1);
  assert.equal(result.value.conversation.truncated, true);
  assert.equal(result.value.conversation.messages[2].text.length, 4000);
  const controller = new AbortController(); controller.abort();
  const cancelled = await rpc('sessions', { sessionId: 's1' }, controller.signal, {});
  assert.equal(cancelled.ok, false); assert.equal(cancelled.error.code, 'E_DASHBOARD_CANCELLED');
  rmSync(f.root, { recursive: true, force: true });
});
