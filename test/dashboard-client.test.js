import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('client is classic ModuleLoader registration with scoped view and unwraps native RPC envelope', async () => {
  const file = resolve('packages/warroom-dashboard/src/client.js');
  const source = readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m);
  let definition;
  const window = { __ModuleLoader__: { load(value) { definition = value; } } };
  vm.runInNewContext(source, { window, AbortController, URL, URLSearchParams, crypto: { randomUUID: () => 'a'.repeat(32) }, console });
  assert.equal(definition.id, '@gungnir/warroom-dashboard');
  const React = { createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }), useEffect() {}, useMemo(fn) { return fn(); }, useRef(value) { return { current: value }; } };
  const module = definition.factory((id) => { if (id === 'react') return React; return {}; });
  assert.equal(module.name, '@gungnir/warroom-dashboard');
  let registered;
  const registrations = [];
  const ctx = {
    slots: {
      inject(name, callback) { registrations.push({ name, callback }); },
      register(value, View) { registered = { value, View }; return () => {}; },
    },
    connection: { rpc: { async call(channel, endpoint, payload) { return { ok: true, value: { endpoint, sessionId: payload.sessionId } }; } } },
  };
  module.apply(ctx);
  assert.equal(registrations[0].name, 'conversation.view');
  registrations[0].callback('trusted-session');
  const props = registered.value.inject('trusted-session');
  assert.equal(props.dashboardSessionId, 'trusted-session');
  assert.equal(registered.value.label(), '战图');
  const bridgeCall = module.__testHooks.createRpcCaller(ctx, 'trusted-session');
  assert.deepEqual(await bridgeCall('/api/snapshot', new AbortController().signal), { endpoint: 'snapshot', sessionId: 'trusted-session' });
});
