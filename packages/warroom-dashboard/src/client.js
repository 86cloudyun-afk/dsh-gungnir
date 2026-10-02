const allowedPaths = new Set(['/api/engagements', '/api/sessions', '/api/snapshot', '/api/demo']);

window.__ModuleLoader__.load({
  id: '@gungnir/warroom-dashboard',
  factory(require) {
    const React = require('react');
    const PREFIX = 'gungnir-dashboard';
    const maxPending = 4;
    let activeContext;

    function createRpcCaller(ctx, sessionId) {
      return async (path, signal) => {
        const url = validatePath(path, sessionId);
        if (signal.aborted) throw abortError();
        const endpoint = url.pathname.slice('/api/'.length);
        const payload = { sessionId };
        if (url.searchParams.has('engagement')) payload.engagementId = url.searchParams.get('engagement');
        const result = await ctx.connection.rpc.call('/warroom-dashboard', endpoint, payload, signal);
        if (!result || typeof result.ok !== 'boolean') throw new Error('Invalid native dashboard RPC response');
        if (!result.ok) throw new Error(result.error?.message || 'Native dashboard request failed');
        return result.value;
      };
    }

    function DashboardView(props) {
      const frame = React.useRef(null);
      const [src, setSrc] = React.useState('about:blank');
      const sessionId = props.dashboardSessionId;
      React.useLayoutEffect(() => {
        if (!sessionId || !frame.current) return undefined;
        const nonce = randomNonce();
        const parentOrigin = window.location.origin;
        const pending = new Map();
        let disposed = false;
        const iframe = frame.current;
        const controllerByRequest = new Map();
        const respond = (requestId, body) => {
          if (disposed) return;
          iframe.contentWindow?.postMessage({ type: `${PREFIX}/response`, nonce, requestId, ...body }, '*');
        };
        const cancel = (requestId) => {
          const controller = controllerByRequest.get(requestId);
          if (controller) controller.abort();
          controllerByRequest.delete(requestId);
          pending.delete(requestId);
        };
        const onMessage = (event) => {
          if (event.source !== iframe.contentWindow || event.origin !== 'null') return;
          const message = event.data;
          if (!message || message.nonce !== nonce || typeof message.requestId !== 'string' || message.requestId.length > 128) return;
          if (message.type === `${PREFIX}/cancel`) {
            if (hasExactKeys(message, ['type', 'nonce', 'requestId'])) cancel(message.requestId);
            return;
          }
          if (message.type !== `${PREFIX}/request` || !hasExactKeys(message, ['type', 'nonce', 'requestId', 'path']) || typeof message.path !== 'string' || pending.has(message.requestId)) return;
          if (pending.size >= maxPending) { respond(message.requestId, { ok: false, error: { message: 'Too many pending requests' } }); return; }
          let path;
          try { path = validatePath(message.path, sessionId); }
          catch { respond(message.requestId, { ok: false, error: { message: 'Invalid dashboard request' } }); return; }
          const controller = new AbortController();
          pending.set(message.requestId, true); controllerByRequest.set(message.requestId, controller);
          createRpcCaller(activeContext, sessionId)(`${path.pathname}${path.search}`, controller.signal).then(
            (data) => respond(message.requestId, { ok: true, data }),
            (error) => { if (error.name !== 'AbortError') respond(message.requestId, { ok: false, error: { message: error.message } }); },
          ).finally(() => cancel(message.requestId));
        };
        window.addEventListener('message', onMessage);
        const query = new URLSearchParams({ embedded: '1', bridgeNonce: nonce, parentOrigin });
        setSrc(`/gungnir-dashboard/?${query}`);
        return () => {
          disposed = true;
          window.removeEventListener('message', onMessage);
          for (const requestId of controllerByRequest.keys()) cancel(requestId);
        };
      }, [sessionId]);
      return React.createElement('iframe', { ref: frame, key: sessionId, title: 'GUNGNIR 战图', sandbox: 'allow-scripts', src, style: { width: '100%', height: '100%', border: '0' } });
    }

    return {
      name: '@gungnir/warroom-dashboard',
      inject: ['connection', 'slots'],
      apply(ctx) {
        activeContext = ctx;
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view', id: 'gungnir-map', order: 80, label: () => '战图',
          inject: (sessionId) => ({ dashboardSessionId: sessionId }),
        }, DashboardView));
      },
      __testHooks: { createRpcCaller },
    };
  },
});

function validatePath(path, sessionId) {
  if (typeof path !== 'string') throw new TypeError('Invalid dashboard endpoint');
  const url = new URL(path, 'http://dashboard.local');
  if (url.origin !== 'http://dashboard.local' || !allowedPaths.has(url.pathname)) throw new TypeError('Invalid dashboard endpoint');
  const allowed = url.pathname === '/api/snapshot' ? new Set(['engagement', 'session']) : new Set();
  for (const [key, value] of url.searchParams) if (!allowed.has(key) || !value || value.length > 160 || !/^[\w:.-]+$/.test(value)) throw new TypeError('Invalid dashboard parameters');
  if (url.searchParams.has('session') && url.searchParams.get('session') !== sessionId) throw new TypeError('Session scope mismatch');
  url.searchParams.delete('session');
  return url;
}
function randomNonce() { return crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''); }
function abortError() { return new DOMException('The operation was aborted', 'AbortError'); }
function hasExactKeys(value, keys) { const actual = Object.keys(value).sort(); return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]); }
