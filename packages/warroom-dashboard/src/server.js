import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoSnapshot, listDashboardEngagements, readDashboardSnapshot } from './snapshot.js';
import { normalizeConversationMessages, redactText } from './conversation.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS = new Map([
  ['/gungnir-dashboard/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/gungnir-dashboard/index.html', ['public/index.html', 'text/html; charset=utf-8']],
  ['/gungnir-dashboard/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/gungnir-dashboard/graph.js', ['public/graph.js', 'text/javascript; charset=utf-8']],
  ['/gungnir-dashboard/transport.js', ['public/transport.js', 'text/javascript; charset=utf-8']],
  ['/gungnir-dashboard/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
]);
const ENDPOINTS = new Set(['/api/engagements', '/api/sessions', '/api/snapshot', '/api/demo']);
const ID = /^[\w:.-]{1,160}$/;

export function createDashboardHandler({ home, conversationProvider } = {}) {
  return async function handle(request, { expectedHost, expectedOrigin } = {}) {
    const method = request.method.toUpperCase();
    const url = new URL(request.url);
    const hostHeader = request.headers.get('host');
    const effectiveHost = expectedHost || url.host;
    if (!['127.0.0.1', '::1', 'localhost'].includes(url.hostname) || (hostHeader && hostHeader !== effectiveHost) || (expectedHost && hostHeader !== expectedHost)) return jsonError(403, 'E_DASHBOARD_ORIGIN', 'Unexpected Host');
    const origin = request.headers.get('origin');
    const effectiveOrigin = expectedOrigin || `${url.protocol}//${effectiveHost}`;
    if (origin && origin !== effectiveOrigin) return jsonError(403, 'E_DASHBOARD_ORIGIN', 'Unexpected Origin');
    const site = request.headers.get('sec-fetch-site');
    if (site && !['same-origin', 'none', 'same-site'].includes(site)) return jsonError(403, 'E_DASHBOARD_ORIGIN', 'Cross-site requests are not allowed');
    if (method !== 'GET' && method !== 'HEAD') return jsonError(405, 'E_DASHBOARD_METHOD', 'Only GET and HEAD are supported', { allow: 'GET, HEAD' });
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    const asset = ASSETS.get(url.pathname);
    if (asset) {
      if (url.search) return jsonError(404, 'E_DASHBOARD_NOT_FOUND', 'Unknown path');
      try {
        const body = await readFile(join(ROOT, asset[0]));
        return new Response(method === 'HEAD' ? null : body, { headers: { 'content-type': asset[1], 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'" } });
      } catch { return jsonError(500, 'E_DASHBOARD_ASSET', 'Dashboard assets are unavailable'); }
    }
    if (!ENDPOINTS.has(url.pathname)) return jsonError(404, 'E_DASHBOARD_NOT_FOUND', 'Unknown path');
    const params = [...url.searchParams.keys()];
    const allowed = url.pathname === '/api/snapshot' ? new Set(['engagement', 'session']) : new Set();
    if (params.some((key) => !allowed.has(key) || url.searchParams.getAll(key).length !== 1) || [...url.searchParams.values()].some((value) => !ID.test(value))) return jsonError(400, 'E_DASHBOARD_REQUEST', 'Invalid query parameters');
    if (url.pathname === '/api/demo') return json(method === 'HEAD' ? null : createDemoSnapshot());
    if (url.pathname === '/api/sessions') return await readSessions(conversationProvider, method);
    if (url.pathname === '/api/engagements') {
      if (!home) return json({ engagements: [] }, 200, method);
      try { return json({ engagements: listDashboardEngagements({ home }) }, 200, method); }
      catch (error) { return errorResponse(error, method); }
    }
    const engagementId = url.searchParams.get('engagement');
    if (!engagementId) return jsonError(400, 'E_DASHBOARD_REQUEST', 'A selected engagement is required');
    const sessionId = url.searchParams.get('session');
    try {
      const snapshot = readDashboardSnapshot({ home, engagementId });
      if (!sessionId) return json(snapshot, 200, method);
      const sessions = await conversationProvider?.listSessions?.();
      const visible = Array.isArray(sessions) ? sessions : [];
      if (visible.filter((session) => session?.id === sessionId).length !== 1) return jsonError(403, 'E_DASHBOARD_SCOPE', 'Selected session is unavailable');
      const raw = await conversationProvider.readMessages(sessionId, { signal: request.signal });
      const messages = Array.isArray(raw) ? raw : Array.isArray(raw?.messages) ? raw.messages : [];
      const normalized = normalizeConversationMessages(messages, snapshot);
      const hasMore = !Array.isArray(raw) && raw?.has_more === true;
      const sourceTotal = Array.isArray(raw) ? normalized.total_count
        : Number.isInteger(raw?.total_count) && raw.total_count >= messages.length ? raw.total_count
          : hasMore ? null : normalized.total_count;
      snapshot.conversation = { status: 'connected', session_id: sessionId, messages: normalized.messages, truncated: normalized.truncated || hasMore };
      snapshot.diagnostics.counts.conversation_messages_total = sourceTotal;
      snapshot.diagnostics.counts.conversation_messages_returned = normalized.messages.length;
      snapshot.diagnostics.counts.conversation_text_truncated = normalized.text_truncated_count;
      if (snapshot.conversation.truncated) {
        snapshot.diagnostics.truncated = true;
        snapshot.diagnostics.warnings.push(sourceTotal == null && hasMore
          ? 'Conversation source has more pages; its total message count is not available.'
          : 'Conversation messages or text were truncated by the dashboard limit.');
      }
      return json(snapshot, 200, method);
    } catch (error) {
      if (error.name === 'AbortError') return jsonError(499, 'E_DASHBOARD_CANCELLED', 'Request cancelled');
      if (error.code?.startsWith('E_DASHBOARD_')) return errorResponse(error, method);
      if (sessionId) {
        try {
          const snapshot = readDashboardSnapshot({ home, engagementId });
          snapshot.conversation = { status: 'unavailable', session_id: sessionId, messages: [] };
          snapshot.diagnostics.warnings.push('Conversation source is unavailable.');
          return json(snapshot, 200, method);
        } catch (snapshotError) { return errorResponse(snapshotError, method); }
      }
      return jsonError(503, 'E_DASHBOARD_SOURCE', 'Conversation source is unavailable');
    }
  };
}

async function readSessions(provider, method) {
  if (!provider || typeof provider.listSessions !== 'function') return json({ sessions: [] }, 200, method);
  try {
    const sessions = await provider.listSessions();
    if (!Array.isArray(sessions)) throw Error('invalid provider response');
    return json({ sessions: sessions.filter((item) => item && typeof item.id === 'string').slice(0, 200).map((item) => ({ id: item.id.slice(0, 160), title: redactText(item.title || item.id).slice(0, 160) })) }, 200, method);
  } catch { return jsonError(503, 'E_DASHBOARD_CONVERSATION', 'Conversation source is unavailable'); }
}
function errorResponse(error, method = 'GET') { return jsonError(error.code === 'E_DASHBOARD_NOT_FOUND' ? 404 : 500, error.code || 'E_DASHBOARD_READ', stableMessage(error), method); }
function stableMessage(error) { return error.code === 'E_DASHBOARD_PATH' ? 'Configured dashboard home is unavailable or invalid' : error.code === 'E_DASHBOARD_NOT_FOUND' ? 'Requested engagement is unavailable' : 'Dashboard data could not be read'; }
function jsonError(status, code, message, headers, method) { return json({ error: { code, message } }, status, method, headers); }
function json(value, status = 200, method = 'GET', extraHeaders = {}) { return new Response(method === 'HEAD' ? null : JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders } }); }

export async function startDashboardServer({ home, port = 0, host = '127.0.0.1', conversationProvider } = {}) {
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') throw new TypeError('Dashboard server must bind to loopback');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid dashboard port');
  const handler = createDashboardHandler({ home, conversationProvider });
  const server = createServer(async (req, res) => {
    const address = server.address();
    const boundHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    const expectedHost = `${boundHost}:${address.port}`;
    const expectedOrigin = `http://${expectedHost}`;
    const request = new Request(`http://${expectedHost}${req.url}`, { method: req.method, headers: req.headers, signal: AbortSignal.timeout(60_000) });
    let response;
    try { response = await handler(request, { expectedHost, expectedOrigin }); }
    catch { response = jsonError(500, 'E_DASHBOARD_INTERNAL', 'Dashboard request failed'); }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (req.method === 'HEAD' || !response.body) { res.end(); return; }
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const address = server.address();
  const urlHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  let closed = false;
  return {
    server,
    url: `http://${urlHost}:${address.port}/gungnir-dashboard/`,
    port: address.port,
    close: async () => { if (closed) return; closed = true; await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
