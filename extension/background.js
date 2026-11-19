// Relays requests from Canvas pages to the local Canvas Library server. Content scripts cannot call
// http://127.0.0.1 themselves (page CORS / CSP), but the extension's service worker can.
const SERVER = 'http://127.0.0.1:47821';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'server') return false;
  (async () => {
    try {
      const res = await fetch(SERVER + msg.path, {
        method: msg.method || 'GET',
        headers: msg.body ? { 'Content-Type': 'application/json' } : undefined,
        body: msg.body ? JSON.stringify(msg.body) : undefined,
      });
      const data = await res.json().catch(() => null);
      sendResponse({ ok: res.ok, status: res.status, data, error: res.ok ? null : data?.error });
    } catch {
      sendResponse({
        ok: false,
        status: 0,
        error: 'Cannot reach the Canvas Library server on port 47821. Start it with "npm run server" (or open Claude with the canvas-library MCP enabled).',
      });
    }
  })();
  return true; // keep the channel open for the async reply
});
