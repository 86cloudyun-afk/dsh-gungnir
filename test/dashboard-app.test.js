import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as graph from '../packages/warroom-dashboard/public/graph.js';

// Minimal inert DOM: execute the actual boot/refresh paths without a browser or sockets.
function appHarness(requestData) {
  class Element {
    constructor(id = '') { this.id = id; this.value = ''; this.children = []; this.dataset = {}; this.hidden = true; this.classList = { toggle() {} }; }
    append(...children) { this.children.push(...children); }
    prepend(...children) { this.children.unshift(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { if (key === 'value') this.value = value; }
    addEventListener() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }
  const elements = new Map();
  const document = {
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, new Element(selector.slice(1))); return elements.get(selector); },
    querySelectorAll() { return []; },
    createElementNS() { return new Element(); },
    createTextNode(text) { return text; },
  };
  const source = readFileSync(new URL('../packages/warroom-dashboard/public/app.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('boot().catch(showError);', '');
  const context = vm.createContext({ document, requestData, AbortController, console, ...graph });
  vm.runInContext(source, context);
  return { ...vm.runInContext('({ boot, refresh, state })', context), elements };
}
const snapshot = () => ({ mode: 'real', nodes: [], edges: [], routes: [], tasks: [], diagnostics: { warnings: [], counts: {} }, conversation: { status: 'connected', messages: [] } });

test('refresh recovers a failed boot engagement list and reloads session metadata', async () => {
  let failing = true;
  const calls = [];
  const app = appHarness(async (path) => {
    calls.push(path);
    if (path === '/api/engagements') { if (failing) throw new Error('temporary source failure'); return { engagements: [{ engagement_id: 'eng-1', name: 'Recovered' }] }; }
    if (path === '/api/sessions') { if (failing) throw new Error('temporary session failure'); return { sessions: [{ id: 's1', title: 'Recovered session' }] }; }
    return snapshot();
  });
  await app.boot();
  assert(app.state.engagementError);
  failing = false;
  await app.refresh();
  assert.equal(app.state.engagementError, null);
  assert.equal(app.state.sessionError, null);
  assert.equal(app.state.engagement, 'eng-1');
  assert.equal(app.state.sessions[0].id, 's1');
  assert(app.state.snapshot);
  assert(calls.some((path) => path.startsWith('/api/snapshot?engagement=eng-1')));
});

test('refresh discovers new scopes after an empty boot and preserves visible selections', async () => {
  let ready = false;
  const app = appHarness(async (path) => {
    if (path === '/api/engagements') return { engagements: ready ? [{ engagement_id: 'eng-1' }, { engagement_id: 'eng-2' }] : [] };
    if (path === '/api/sessions') return { sessions: ready ? [{ id: 's1' }, { id: 's2' }] : [] };
    return snapshot();
  });
  await app.boot();
  ready = true;
  await app.refresh();
  assert.equal(app.state.engagement, 'eng-1');
  app.state.engagement = 'eng-2'; app.state.session = 's2';
  await app.refresh();
  assert.equal(app.state.engagement, 'eng-2');
  assert.equal(app.state.session, 's2');
});

test('superseded metadata reads cannot overwrite the current refresh scope', async () => {
  const pending = [];
  let stall = true;
  const app = appHarness(async (path) => {
    if (path === '/api/engagements') return stall ? new Promise((resolve) => pending.push(resolve)) : { engagements: [{ engagement_id: 'current' }] };
    if (path === '/api/sessions') return { sessions: [] };
    return snapshot();
  });
  const older = app.boot();
  await Promise.resolve();
  stall = false;
  await app.refresh();
  pending[0]({ engagements: [{ engagement_id: 'stale' }] });
  await older;
  assert.equal(app.state.engagement, 'current');
});

test('transient session metadata failure preserves the selected visible session until a successful list removes it', async () => {
  let sessions = [{ id: 's1', title: 'Selected session' }];
  let failSessions = false;
  const calls = [];
  const app = appHarness(async (path) => {
    calls.push(path);
    if (path === '/api/engagements') return { engagements: [{ engagement_id: 'eng-1' }] };
    if (path === '/api/sessions') { if (failSessions) throw new Error('temporary failure'); return { sessions }; }
    return snapshot();
  });
  await app.boot();
  assert.equal(app.state.session, 's1');
  failSessions = true;
  await app.refresh();
  assert.equal(app.state.session, 's1');
  assert.equal(app.state.sessions[0].id, 's1');
  assert(app.state.sessionError);
  assert.equal(calls.at(-1), '/api/snapshot?engagement=eng-1&session=s1');
  failSessions = false; sessions = [];
  await app.refresh();
  assert.equal(app.state.session, '');
  assert.equal(app.state.sessionError, null);
});

test('transient engagement metadata failure preserves selected scope options through recovery', async () => {
  let failEngagements = false;
  const app = appHarness(async (path) => {
    if (path === '/api/engagements') {
      if (failEngagements) throw new Error('temporary engagement failure');
      return { engagements: [{ engagement_id: 'eng-1' }, { engagement_id: 'eng-2' }] };
    }
    if (path === '/api/sessions') return { sessions: [] };
    return snapshot();
  });
  await app.boot();
  app.state.engagement = 'eng-2';
  failEngagements = true;
  await app.refresh();
  assert.equal(app.state.engagement, 'eng-2');
  assert.deepEqual(app.elements.get('#engagement-select').children.map((option) => option.value), ['eng-1', 'eng-2']);
  failEngagements = false;
  await app.refresh();
  assert.equal(app.state.engagement, 'eng-2');
  assert.equal(app.state.engagementError, null);
  assert(app.state.snapshot);
});
