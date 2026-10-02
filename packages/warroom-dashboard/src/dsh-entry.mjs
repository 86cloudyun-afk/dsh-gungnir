import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoSnapshot, listDashboardEngagements, readDashboardSnapshot } from './snapshot.js';
import { parseDshPageRecords } from './conversation.js';

const CHANNEL = '/warroom-dashboard';
const BASE = '/gungnir-dashboard';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS = new Map([
  [`${BASE}`, ['public/index.html', 'text/html; charset=utf-8']],
  [`${BASE}/`, ['public/index.html', 'text/html; charset=utf-8']],
  [`${BASE}/index.html`, ['public/index.html', 'text/html; charset=utf-8']],
  [`${BASE}/app.js`, ['public/app.js', 'text/javascript; charset=utf-8']],
  [`${BASE}/graph.js`, ['public/graph.js', 'text/javascript; charset=utf-8']],
  [`${BASE}/transport.js`, ['public/transport.js', 'text/javascript; charset=utf-8']],
  [`${BASE}/styles.css`, ['public/styles.css', 'text/css; charset=utf-8']],
]);
const CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; frame-ancestors 'self'";
const SAFE_ID = /^[\w:.-]{1,160}$/;
export const name = 'gungnir-dashboard';
export const inject = ['webServer', 'connection', 'sessionController'];

export function apply(ctx, config = {}) {
  const home = config.home || process.env.WARROOM_HOME || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'warroom') : undefined);
  const bindings = validateBindings(config.sessionBindings);
  const disposers = [];
  const registerRpc = (connectionCtx) => {
    // rpc.handle captures its owner context. Use the injected child context's
    // root connection as the installed dsh-ops-console precedent does, while
    // keeping the disposer owned by the injected child lifecycle.
    const install = () => connectionCtx.root.connection.rpc.handle(CHANNEL, async (endpoint, payload, signal, _peer) => {
      try {
        checkSignal(signal);
        const scope = await validateScope(ctx, bindings, payload, signal);
        checkSignal(signal);
        let value;
        if (endpoint === 'engagements') value = { engagements: listDashboardEngagements({ home }).filter((item) => item.engagement_id === scope.engagementId) };
        else if (endpoint === 'sessions') value = { sessions: [{ id: scope.sessionId, title: scope.session.title || scope.sessionId }] };
        else if (endpoint === 'demo') value = createDemoSnapshot();
        else if (endpoint === 'snapshot') value = await readNativeSnapshot(ctx, home, scope, signal);
        else return failure('E_DASHBOARD_ENDPOINT', 'Unknown dashboard endpoint');
        checkSignal(signal);
        return { ok: true, value };
      } catch (error) {
        if (error.code === 'E_DASHBOARD_SCOPE' || error.code === 'E_DASHBOARD_CANCELLED') return failure(error.code, error.message);
        return failure(error.code || 'E_DASHBOARD_READ', safeErrorMessage(error));
      }
    });
    if (typeof connectionCtx.effect === 'function') connectionCtx.effect(install, 'gungnir-dashboard rpc');
    else {
      const off = install();
      if (typeof off === 'function') disposers.push(off);
    }
  };
  const registerStatic = () => {
    disposers.push(ctx.webServer.register({ kind: 'prefix', path: BASE, handler: (req, res) => serveStatic(req, res) }));
  };
  if (typeof ctx.effect === 'function') ctx.effect(() => { registerStatic(); return async () => disposeAll(disposers); }, 'gungnir-dashboard static');
  else registerStatic();
  if (typeof ctx.inject === 'function') ctx.inject(['connection'], (connectionCtx) => registerRpc(connectionCtx));
  else if (ctx.root?.connection) registerRpc(ctx);
  else throw new Error('Dashboard RPC registration requires an injected connection context');
  return async () => disposeAll(disposers);
}

export default { name, inject, apply };

async function validateScope(ctx, bindings, payload, signal) {
  if (!payload || typeof payload !== 'object' || !SAFE_ID.test(payload.sessionId || '')) throw scopeError('A valid sessionId is required');
  const engagementId = Object.hasOwn(bindings, payload.sessionId) ? bindings[payload.sessionId] : null;
  if (!engagementId || (payload.engagementId != null && payload.engagementId !== engagementId)) throw scopeError('Session is not bound to the requested engagement');
  checkSignal(signal);
  const result = await ctx.sessionController.list({}, signal);
  checkSignal(signal);
  const session = result?.items?.find((item) => item.sessionId === payload.sessionId);
  if (!session) throw scopeError('Session is not currently visible');
  return { sessionId: payload.sessionId, engagementId, session };
}

async function readNativeSnapshot(ctx, home, scope, signal) {
  const snapshot = readDashboardSnapshot({ home, engagementId: scope.engagementId });
  checkSignal(signal);
  const inspected = await ctx.sessionController.inspect(scope.sessionId, signal);
  checkSignal(signal);
  const last = inspected?.events?.at(-1)?.seq;
  if (!Number.isInteger(last) || last < 0) {
    snapshot.conversation = { status: 'connected', session_id: scope.sessionId, messages: [] };
    return snapshot;
  }
  const page = await ctx.sessionController.page({ address: { kind: 'session', sessionId: scope.sessionId }, throughSeq: last, maxMessages: 200 }, signal);
  checkSignal(signal);
  const normalized = parseDshPageRecords(page?.records || [], snapshot);
  const totalMessages = (inspected?.events || []).filter(isDisplayableEvent).length;
  const truncated = normalized.truncated || Boolean(page?.hasMore) || totalMessages > normalized.messages.length;
  snapshot.conversation = { status: 'connected', session_id: scope.sessionId, messages: normalized.messages, truncated };
  snapshot.diagnostics.counts.conversation_messages_total = totalMessages;
  snapshot.diagnostics.counts.conversation_messages_returned = normalized.messages.length;
  snapshot.diagnostics.counts.conversation_text_truncated = normalized.text_truncated_count;
  if (truncated) {
    snapshot.diagnostics.truncated = true;
    snapshot.diagnostics.warnings.push('Conversation messages or text were truncated by the dashboard page limit.');
  }
  return snapshot;
}

function isDisplayableEvent(event) {
  const data = event?.data;
  return (event?.type === 'user/message' && data?.role === 'user' && data.source?.kind === 'user')
    || (event?.type === 'assistant/message' && data?.message?.role === 'assistant' && data.message.source?.kind === 'model');
}

function validateBindings(value) {
  const bindings = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze(bindings);
  for (const [sessionId, engagementId] of Object.entries(value)) {
    if (!SAFE_ID.test(sessionId) || typeof engagementId !== 'string' || !SAFE_ID.test(engagementId)) throw new TypeError('Invalid dashboard sessionBindings configuration');
    bindings[sessionId] = engagementId;
  }
  return Object.freeze(bindings);
}
function serveStatic(req, res) {
  const method = req.method || 'GET';
  let asset;
  try { asset = ASSETS.get(new URL(req.url || '/', 'http://dsh.local').pathname); }
  catch { asset = null; }
  const headers = {
    ...(asset ? { 'content-type': asset[1] } : {}),
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  };
  if (!asset) { res.writeHead(404, headers); res.end(); return; }
  if (method !== 'GET' && method !== 'HEAD') { res.writeHead(405, { ...headers, allow: 'GET, HEAD' }); res.end(); return; }
  return readFile(join(ROOT, asset[0])).then((body) => {
    res.writeHead(200, headers);
    res.end(method === 'HEAD' ? undefined : body);
  }, () => { res.writeHead(500, headers); res.end(); });
}
function checkSignal(signal) { if (signal?.aborted) throw Object.assign(new Error('Request cancelled'), { code: 'E_DASHBOARD_CANCELLED' }); }
function scopeError(message) { return Object.assign(new Error(message), { code: 'E_DASHBOARD_SCOPE' }); }
function failure(code, message) { return { ok: false, error: { code, message, details: {} } }; }
function safeErrorMessage(error) { return error.code?.startsWith('E_DASHBOARD_') ? error.message : 'Dashboard data could not be read'; }
async function disposeAll(disposers) { for (const dispose of disposers.splice(0).reverse()) if (typeof dispose === 'function') await dispose(); }
