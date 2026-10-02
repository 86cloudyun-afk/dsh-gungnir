const PREFIX = 'gungnir-dashboard';
const ENDPOINTS = new Set(['/api/engagements', '/api/snapshot', '/api/sessions', '/api/demo']);
const DEFAULT_TIMEOUT = 12000;
let requestSequence = 0;

export function requestData(path, { signal, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const url = validatePath(path);
  const embedded = new URL(globalThis.location?.href || 'http://127.0.0.1/').searchParams.get('embedded') === '1';
  if (embedded) {
    const params = new URL(globalThis.location.href).searchParams;
    return createBridge(globalThis, {
      parentOrigin: params.get('parentOrigin'), nonce: params.get('bridgeNonce'), timeoutMs,
    }).request(url, { signal });
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Dashboard request timed out')), timeoutMs);
  return fetch(url, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' }, signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Dashboard request failed (${response.status})`);
      return response.json();
    })
    .finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); });
}

function validatePath(path) {
  if (typeof path !== 'string') throw new TypeError('Invalid dashboard endpoint');
  const url = new URL(path, 'http://dashboard.local');
  if (url.origin !== 'http://dashboard.local' || !ENDPOINTS.has(url.pathname)) throw new TypeError('Invalid dashboard endpoint');
  const allowed = url.pathname === '/api/snapshot' ? new Set(['engagement', 'session']) : new Set();
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || !value || value.length > 160 || !/^[\w:.-]+$/.test(value)) throw new TypeError('Invalid dashboard endpoint parameters');
  }
  return `${url.pathname}${url.search}`;
}

function createBridge(environment, { parentOrigin, nonce, timeoutMs }) {
  const parent = environment.parent;
  if (!parent || parent === environment || !isOrigin(parentOrigin) || !isNonce(nonce)) throw new Error('Invalid embedded dashboard bridge configuration');
  return {
    request(path, { signal } = {}) {
      if (signal?.aborted) return Promise.reject(abortError());
      const requestId = `${Date.now().toString(36)}-${(++requestSequence).toString(36)}`;
      return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          environment.removeEventListener('message', onMessage);
          environment.clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          cleanup();
          callback(value);
        };
        const cancel = () => parent.postMessage({ type: `${PREFIX}/cancel`, nonce, requestId }, parentOrigin);
        const onAbort = () => { cancel(); finish(reject, abortError()); };
        const onMessage = (event) => {
          if (event.source !== parent || event.origin !== parentOrigin) return;
          const message = event.data;
          if (!message || message.type !== `${PREFIX}/response` || message.nonce !== nonce || message.requestId !== requestId || typeof message.ok !== 'boolean') return;
          if (message.ok) finish(resolve, message.data);
          else finish(reject, new Error(typeof message.error?.message === 'string' ? message.error.message : 'Embedded dashboard request failed'));
        };
        environment.addEventListener('message', onMessage);
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = environment.setTimeout(() => {
          cancel();
          finish(reject, new Error('Embedded dashboard request timed out'));
        }, timeoutMs);
        parent.postMessage({ type: `${PREFIX}/request`, nonce, requestId, path }, parentOrigin);
      });
    },
  };
}

function isOrigin(value) {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value; } catch { return false; }
}
function isNonce(value) { return typeof value === 'string' && /^[a-f\d-]{24,128}$/i.test(value); }
function abortError() { return new DOMException('The operation was aborted', 'AbortError'); }

export const __transportTestHooks = {
  async withEmbeddedRuntime(callback, { parentOrigin = 'https://host.example', nonce = 'aabbccddeeff001122334455' } = {}) {
    const saved = new Map();
    const listeners = new Set();
    const sent = [];
    let fetchCalls = 0;
    const parent = { postMessage(message, targetOrigin) { sent.push({ message, targetOrigin }); } };
    const setGlobal = (key, value) => {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    };
    const runtimeUrl = `https://child.example/dashboard/?embedded=1&bridgeNonce=${nonce}&parentOrigin=${encodeURIComponent(parentOrigin)}`;
    setGlobal('location', { href: runtimeUrl });
    setGlobal('parent', parent);
    setGlobal('addEventListener', (type, listener) => { if (type === 'message') listeners.add(listener); });
    setGlobal('removeEventListener', (type, listener) => { if (type === 'message') listeners.delete(listener); });
    setGlobal('fetch', async () => { fetchCalls += 1; throw new Error('embedded mode must not use fetch'); });
    const harness = {
      parent,
      sent,
      dispatch(data, origin = parentOrigin) {
        for (const listener of [...listeners]) listener({ source: parent, origin, data });
      },
      get listenerCount() { return listeners.size; },
      get fetchCalls() { return fetchCalls; },
    };
    try {
      return await callback(harness);
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  },
  createHarness({ embedded, parentOrigin, bridgeNonce, timeoutMs = DEFAULT_TIMEOUT }) {
    const listeners = new Set();
    const sent = [];
    const parent = { postMessage(message, targetOrigin) { sent.push({ message, targetOrigin }); } };
    const environment = {
      parent,
      addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
      removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
      setTimeout, clearTimeout,
    };
    const bridge = embedded ? createBridge(environment, { parentOrigin, nonce: bridgeNonce, timeoutMs }) : null;
    return {
      parent, sent,
      get listenerCount() { return listeners.size; },
      get fetchCalls() { return 0; },
      request: (path, options) => (bridge || { request: (endpoint, config) => requestData(endpoint, config) }).request(validatePath(path), options),
      dispatch(event) { for (const listener of [...listeners]) listener(event); },
    };
  },
};
