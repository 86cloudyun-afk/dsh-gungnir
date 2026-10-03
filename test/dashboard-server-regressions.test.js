import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { createDashboardHandler, startDashboardServer } from '../packages/warroom-dashboard/src/server.js';

test('unsupported TRACE is rejected inside the server boundary without a rejected callback', async () => {
  const original = http.createServer;
  let callback;
  const server = new EventEmitter();
  server.address = () => ({ family: 'IPv4', address: '127.0.0.1', port: 12345 });
  server.listen = (_port, _host, ready) => ready();
  server.close = (ready) => ready();
  http.createServer = (handler) => { callback = handler; return server; };
  syncBuiltinESMExports();
  try {
    const running = await startDashboardServer();
    let status;
    const res = { writeHead(code) { status = code; }, end() {} };
    await callback({ url: '/api/demo', method: 'TRACE', headers: { host: '127.0.0.1:12345' } }, res);
    assert.equal(status, 405);
    await running.close();
  } finally { http.createServer = original; syncBuiltinESMExports(); }
});

test('HEAD database failures return a bodyless error with intact headers', async () => {
  const response = await createDashboardHandler({ home: '/dashboard-inert-missing-home' })(new Request('http://127.0.0.1/api/engagements', { method: 'HEAD' }));
  assert.equal(response.status, 500);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.has('0'), false);
});

test('HEAD validation errors never include a response body', async () => {
  const handler = createDashboardHandler();
  for (const url of ['http://evil.example/api/demo', 'http://127.0.0.1/unknown', 'http://127.0.0.1/api/snapshot', 'http://127.0.0.1/api/demo?extra=x']) {
    const response = await handler(new Request(url, { method: 'HEAD' }));
    assert(response.status >= 400);
    assert.equal(await response.text(), '', url);
  }
});

test('bracketed IPv6 loopback is accepted while nonloopback IPv6 is denied', async () => {
  const handler = createDashboardHandler();
  const response = await handler(new Request('http://[::1]:12345/api/demo', { headers: { host: '[::1]:12345' } }), { expectedHost: '[::1]:12345', expectedOrigin: 'http://[::1]:12345' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, 'demo');
  assert.equal((await handler(new Request('http://[2001:db8::1]/api/demo'))).status, 403);
});
