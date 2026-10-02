import test from 'node:test';
import assert from 'node:assert/strict';
import { requestData, __transportTestHooks } from '../packages/warroom-dashboard/public/transport.js';

const allowed = '/api/sessions';
test('local transport fetches only allowlisted read endpoints and propagates abort', async () => {
  const originalFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (path, options) => { seen = { path, options }; return { ok: true, json: async () => ({ sessions: [] }) }; };
  try {
    const controller = new AbortController();
    assert.deepEqual(await requestData(allowed, { signal: controller.signal }), { sessions: [] });
    assert.equal(seen.path, allowed);
    assert.equal(seen.options.signal, controller.signal);
    assert.throws(() => requestData('/api/snapshot?engagement=../secret'), /endpoint/i);
  } finally { globalThis.fetch = originalFetch; }
});

test('embedded bridge validates parent source, origin, nonce and shape; never falls back to HTTP', async () => {
  const harness = __transportTestHooks.createHarness({ embedded: true, parentOrigin: 'https://host.example', bridgeNonce: 'aabbccddeeff001122334455' });
  const pending = harness.request(allowed);
  const request = harness.sent[0];
  assert.equal(request.message.type, 'gungnir-dashboard/request');
  assert.equal(request.message.path, allowed);
  harness.dispatch({ source: {}, origin: 'https://host.example', data: { type: 'gungnir-dashboard/response', nonce: 'aabbccddeeff001122334455', requestId: request.message.requestId, ok: true, data: 1 } });
  harness.dispatch({ source: harness.parent, origin: 'https://evil.example', data: { type: 'gungnir-dashboard/response', nonce: 'aabbccddeeff001122334455', requestId: request.message.requestId, ok: true, data: 2 } });
  harness.dispatch({ source: harness.parent, origin: 'https://host.example', data: { type: 'gungnir-dashboard/response', nonce: 'wrong', requestId: request.message.requestId, ok: true, data: 3 } });
  harness.dispatch({ source: harness.parent, origin: 'https://host.example', data: { type: 'gungnir-dashboard/response', nonce: 'aabbccddeeff001122334455', requestId: request.message.requestId, ok: true, data: { accepted: true } } });
  assert.deepEqual(await pending, { accepted: true });
  assert.equal(harness.fetchCalls, 0);
  assert.equal(harness.listenerCount, 0);
});

test('embedded abort and timeout send cancellation and remove listeners', async () => {
  const harness = __transportTestHooks.createHarness({ embedded: true, parentOrigin: 'https://host.example', bridgeNonce: 'aabbccddeeff001122334455', timeoutMs: 20 });
  const controller = new AbortController();
  const aborted = harness.request(allowed, { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  assert.equal(harness.sent.at(-1).message.type, 'gungnir-dashboard/cancel');
  assert.equal(harness.listenerCount, 0);
  const timedOut = harness.request(allowed);
  await assert.rejects(timedOut, /timed out/i);
  assert.equal(harness.listenerCount, 0);
  assert.equal(harness.fetchCalls, 0);
});

test('concurrent public embedded requests keep unique IDs when the clock is fixed', async () => {
  const originalNow = Date.now;
  Date.now = () => 1700000000000;
  try {
    await __transportTestHooks.withEmbeddedRuntime(async (harness) => {
      const engagements = requestData('/api/engagements');
      const sessions = requestData('/api/sessions');
      const requests = harness.sent.map((entry) => entry.message);
      assert.equal(requests.length, 2);
      assert.notEqual(requests[0].requestId, requests[1].requestId);
      assert.deepEqual(requests.map((request) => request.type), ['gungnir-dashboard/request', 'gungnir-dashboard/request']);
      harness.dispatch({ type: 'gungnir-dashboard/response', nonce: 'aabbccddeeff001122334455', requestId: requests[1].requestId, ok: true, data: { sessions: ['one'] } });
      harness.dispatch({ type: 'gungnir-dashboard/response', nonce: 'aabbccddeeff001122334455', requestId: requests[0].requestId, ok: true, data: { engagements: ['alpha'] } });
      assert.deepEqual(await Promise.all([engagements, sessions]), [{ engagements: ['alpha'] }, { sessions: ['one'] }]);
      assert.equal(harness.listenerCount, 0);
      assert.equal(harness.fetchCalls, 0);
    });
  } finally {
    Date.now = originalNow;
  }
});
