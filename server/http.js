import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIBRARY_DIR, MAX_BODY_BYTES, PORT } from './config.js';
import * as lib from './library.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function send(res, status, body, headers = {}) {
  const isBuf = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isBuf ? 'text/plain; charset=utf-8' : 'application/json', ...headers });
  res.end(isBuf ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  try {
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

/**
 * Only the user's own extension and this server's own pages may talk to the API.
 * - Host must be loopback (blocks DNS-rebinding attacks).
 * - A browser request carrying an Origin must come from a chrome-extension:// page or from ourselves
 *   (blocks any website from posting to localhost).
 * Requests without an Origin (curl, the MCP process) are fine: only local processes can make them.
 */
function guard(req, port) {
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin.startsWith('chrome-extension://') || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

// Chunked uploads: the extension sends big files as base64 pieces so no single message is huge.
function appendChunk(uploadId, index, buffer) {
  const dir = lib.tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${lib.safeId(uploadId)}.part`);
  if (index === 0) fs.writeFileSync(file, buffer);
  else fs.appendFileSync(file, buffer);
  return file;
}

export function createHandler(port) {
  return async (req, res) => {
    const cors = corsHeaders(req);
    try {
      if (!guard(req, port)) return send(res, 403, { error: 'forbidden' });
      if (req.method === 'OPTIONS') return send(res, 204, '', cors);

      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const p = url.pathname;
      const reply = (status, body) => send(res, status, body, cors);

      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        return send(res, 200, fs.readFileSync(path.join(HERE, 'ui.html')), { 'Content-Type': 'text/html; charset=utf-8' });
      }
      if (req.method === 'GET' && p === '/api/health') return reply(200, { ok: true, name: 'canvas-library', libraryDir: LIBRARY_DIR });
      if (req.method === 'GET' && p === '/api/library') return reply(200, { courses: lib.librarySummary() });

      if (req.method === 'GET' && p === '/api/read') {
        const r = lib.resolveRef(url.searchParams.get('course'), url.searchParams.get('ref'));
        if (!r) return reply(404, { error: 'not found' });
        return reply(200, r);
      }
      if (req.method === 'GET' && p === '/api/module') {
        const m = lib.getModule(url.searchParams.get('course'), url.searchParams.get('module'));
        return m ? reply(200, m) : reply(404, { error: 'not found' });
      }

      if (req.method === 'POST' && p === '/api/module') {
        const body = await readJson(req);
        if (!body.course?.id || !body.module?.id) return reply(400, { error: 'course.id and module.id required' });
        return reply(200, { ok: true, ...lib.saveModule(body) });
      }

      if (req.method === 'POST' && p === '/api/file-chunk') {
        const b = await readJson(req);
        const buf = Buffer.from(String(b.data || ''), 'base64');
        const part = appendChunk(b.uploadId, Number(b.index) || 0, buf);
        if (!b.last) return reply(200, { ok: true });
        const full = fs.readFileSync(part);
        fs.rmSync(part, { force: true });
        const out = await lib.saveFileBytes(b.courseId, b.fileId, full, { name: b.name, contentType: b.contentType });
        return reply(200, { ok: true, ...out });
      }

      if (req.method === 'POST' && p === '/api/file-note') {
        const b = await readJson(req);
        lib.noteFile(b.courseId, b.fileId, String(b.note || '').slice(0, 300));
        return reply(200, { ok: true });
      }

      if (req.method === 'DELETE' && p === '/api/module') {
        lib.removeModule(url.searchParams.get('course'), url.searchParams.get('module'));
        return reply(200, { ok: true });
      }
      if (req.method === 'DELETE' && p === '/api/course') {
        lib.removeCourse(url.searchParams.get('course'));
        return reply(200, { ok: true });
      }

      return reply(404, { error: 'not found' });
    } catch (e) {
      console.error('[canvas-library] request error:', e);
      return send(res, e.status || 500, { error: String(e.message || e) }, cors);
    }
  };
}

/**
 * Start the ingest/management server. Resolves with the server, or null if the port is already
 * taken (another instance is serving the same library folder, which is fine).
 */
export function startHttp(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(createHandler(port));
    server.once('error', (e) => (e.code === 'EADDRINUSE' ? resolve(null) : reject(e)));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
