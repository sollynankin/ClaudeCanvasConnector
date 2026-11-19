// End-to-end test: mock Canvas -> crawler (same code the extension runs) -> ingest server -> MCP server.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-lib-test-'));
const INGEST_PORT = 47900 + Math.floor(Math.random() * 90);
process.env.CANVAS_LIBRARY_DIR = LIB;
process.env.CANVAS_LIBRARY_PORT = String(INGEST_PORT);

const require = createRequire(import.meta.url);
const { createApi, runImport } = require('../extension/crawler.js');
const { startHttp } = await import('../server/http.js');

/* ------------------------------------------------------------ fixtures */

async function makePptx() {
  const z = new JSZip();
  const slide = (t) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
  z.file('ppt/slides/slide1.xml', slide('Mitochondria are the powerhouse of the cell'));
  z.file('ppt/slides/slide2.xml', slide('Krebs cycle &amp; oxidative phosphorylation'));
  z.file('ppt/notesSlides/notesSlide2.xml', slide('Remember NADH and FADH2'));
  return z.generateAsync({ type: 'nodebuffer' });
}

function makePdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 18 Tf 20 80 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

const pptx = await makePptx();
const pdf = makePdf('Photosynthesis converts light into chemical energy');

const FILES = {
  501: { id: 501, display_name: 'lecture1.pdf', filename: 'lecture1.pdf', 'content-type': 'application/pdf', size: pdf.length, modified_at: '2026-01-01T00:00:00Z', bytes: pdf },
  502: { id: 502, display_name: 'cells.pptx', filename: 'cells.pptx', 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: pptx.length, modified_at: '2026-01-02T00:00:00Z', bytes: pptx },
};

/* ------------------------------------------------------------ mock Canvas */

const canvas = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const origin = `http://${req.headers.host}`;
  const json = (obj, headers = {}) => { res.writeHead(200, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
  const p = u.pathname;
  if (p === '/api/v1/courses/42') return json({ id: 42, name: 'BIOL 101: Cell Biology', course_code: 'BIOL101', term: { name: 'Fall 2026' } });
  if (p === '/api/v1/courses/42/modules') {
    if (u.searchParams.get('page') === '2') return json([{ id: 8, name: 'Week 2: Metabolism', position: 2, items_count: 1 }]);
    return json([{ id: 7, name: 'Week 1: Cells', position: 1, items_count: 6 }], { Link: `<${origin}/api/v1/courses/42/modules?page=2&per_page=100>; rel="next"` });
  }
  if (p === '/api/v1/courses/42/modules/7/items') {
    return json([
      { id: 1, type: 'SubHeader', title: 'Readings', indent: 0, position: 1 },
      { id: 2, type: 'Page', title: 'Welcome', indent: 1, position: 2, page_url: 'welcome', html_url: `${origin}/courses/42/pages/welcome` },
      { id: 3, type: 'Assignment', title: 'Lab report 1', indent: 1, position: 3, content_id: 11 },
      { id: 4, type: 'Discussion', title: 'Locked discussion', indent: 1, position: 4, content_id: 12 },
      { id: 5, type: 'File', title: 'Lecture 1 slides', indent: 1, position: 5, content_id: 501, content_details: { size: pdf.length } },
      { id: 6, type: 'ExternalUrl', title: 'Khan Academy', indent: 1, position: 6, external_url: 'https://khanacademy.org' },
    ]);
  }
  if (p === '/api/v1/courses/42/modules/8/items') return json([{ id: 9, type: 'Quiz', title: 'Quiz 2', indent: 0, position: 1, content_id: 13 }]);
  if (p === '/api/v1/courses/42/pages/welcome') {
    return json({ title: 'Welcome', updated_at: '2026-01-01', body: '<h2>Welcome to BIOL 101</h2><p>Read <a href="/courses/42/pages/syllabus">the syllabus</a>.</p><table><tr><th>Week</th><th>Topic</th></tr><tr><td>1</td><td>Cells</td></tr></table><p><a class="instructure_file_link" href="/courses/42/files/502/download?wrap=1" data-api-endpoint="/api/v1/courses/42/files/502">cells.pptx</a></p>' });
  }
  if (p === '/api/v1/courses/42/assignments/11') {
    return json({ name: 'Lab report 1', description: '<p>Write up the <strong>osmosis</strong> experiment.</p>', due_at: '2026-09-30T23:59:00Z', points_possible: 25, submission_types: ['online_upload'], rubric: [{ description: 'Method', points: 10, ratings: [{ points: 10, description: 'Complete' }, { points: 0, description: 'Missing' }] }] });
  }
  if (p === '/api/v1/courses/42/discussion_topics/12') { res.writeHead(403); return res.end('{"errors":[{"message":"user not authorized"}]}'); }
  if (p === '/api/v1/courses/42/quizzes/13') return json({ title: 'Quiz 2', description: '<p>Covers glycolysis.</p>', points_possible: 10, question_count: 8, time_limit: 20 });
  const fm = p.match(/^\/api\/v1\/files\/(\d+)$/);
  if (fm && FILES[fm[1]]) {
    const { bytes, ...meta } = FILES[fm[1]];
    return json({ ...meta, url: `${origin}/files/${meta.id}/download?download_frd=1&verifier=SECRET` });
  }
  const dm = p.match(/^\/files\/(\d+)\/download$/);
  if (dm && FILES[dm[1]]) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(FILES[dm[1]].bytes); }
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => canvas.listen(0, '127.0.0.1', r));
const CANVAS = `http://127.0.0.1:${canvas.address().port}`;

/* ------------------------------------------------------------ ingest server */

const ingest = await startHttp(INGEST_PORT);
assert.ok(ingest, 'ingest server should start');
const BASE = `http://127.0.0.1:${INGEST_PORT}`;
const EXT = { Origin: 'chrome-extension://testextensionid' };

async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...EXT }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.status);
  return data;
}

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

try {
  // --- security guard
  const evil = await fetch(`${BASE}/api/library`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.status, 403); ok('rejects requests from ordinary websites');
  const rebinding = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: INGEST_PORT, path: '/api/library', headers: { Host: 'evil.example' } }, (r) => resolve(r.statusCode));
  });
  assert.equal(rebinding, 403); ok('rejects DNS-rebinding Host headers');
  const good = await fetch(`${BASE}/api/library`, { headers: EXT });
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('access-control-allow-origin'), EXT.Origin); ok('accepts the extension origin with CORS');

  // --- import module 7 (with files) through the real crawler
  const progress = [];
  const api = createApi({ origin: CANVAS, fetchImpl: fetch });
  const summary = await runImport({ api, origin: CANVAS, courseId: '42', moduleIds: ['7'], withFiles: true, post, onProgress: (m) => progress.push(m) });
  assert.equal(summary.modules, 1);
  assert.equal(summary.items, 6);
  assert.equal(summary.files, 2);
  assert.equal(summary.downloaded, 2, JSON.stringify(summary));
  assert.equal(summary.warnings.length, 1);
  assert.match(summary.warnings[0], /Locked discussion.*403/);
  assert.ok(progress.length > 3);
  ok('imports a module (items, linked files, downloads, 403 becomes a warning)');

  // pagination: module 8 lives on page 2 of the modules listing
  const s2 = await runImport({ api, origin: CANVAS, courseId: '42', moduleIds: ['8'], withFiles: false, post });
  assert.equal(s2.modules, 1); ok('follows Canvas pagination Link headers');

  // re-import must not re-download unchanged files
  const again = await runImport({ api, origin: CANVAS, courseId: '42', moduleIds: ['7'], withFiles: true, post });
  assert.equal(again.downloaded, 0); ok('re-adding a module skips files that are already stored');

  // --- library summary
  const lib = (await (await fetch(`${BASE}/api/library`, { headers: EXT })).json()).courses;
  assert.equal(lib.length, 1);
  assert.deepEqual(lib[0].modules.map((m) => m.name).sort(), ['Week 1: Cells', 'Week 2: Metabolism']);
  assert.equal(lib[0].files['501'].stored, true); ok('library summary lists modules and stored files');

  const metaJson = fs.readFileSync(path.join(LIB, 'courses/42/files/501/meta.json'), 'utf8');
  assert.ok(!metaJson.includes('SECRET'), 'verifier token must not be persisted'); ok('does not persist file verifier tokens');

  // --- MCP over stdio
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'server/mcp.js')],
    env: { ...process.env, CANVAS_LIBRARY_DIR: LIB, CANVAS_LIBRARY_PORT: String(INGEST_PORT) },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['get_module', 'list_courses', 'list_modules', 'read', 'search']); ok('MCP exposes the five tools');

  let r = await call('list_courses');
  assert.match(r.text, /42: BIOL 101: Cell Biology \[BIOL101\] — 2 module\(s\)/); ok('list_courses');

  r = await call('list_modules');
  assert.match(r.text, /7: Week 1: Cells — 6 item\(s\)/);
  assert.match(r.text, /8: Week 2: Metabolism/); ok('list_modules (course inferred, only one in library)');

  r = await call('get_module', { module_id: 'week 1' });
  assert.match(r.text, /## Readings/);
  assert.match(r.text, /\[Page\] Welcome\s+→\s+item\/2.*1 linked file/);
  assert.match(r.text, /\[File\] Lecture 1 slides\s+→\s+file\/501/);
  assert.match(r.text, /import warning: HTTP 403/); ok('get_module (name match, outline, warnings)');

  r = await call('read', { ref: 'item/2' });
  assert.match(r.text, /# Welcome to BIOL 101/);
  assert.ok(r.text.includes(`${CANVAS}/courses/42/pages/syllabus`), 'relative links are made absolute');
  assert.match(r.text, /\| Week \| Topic \|/);
  assert.match(r.text, /file\/502: cells\.pptx/); ok('read page (markdown, tables, absolute links, linked files)');

  r = await call('read', { ref: 'item/3' });
  assert.match(r.text, /Due: 2026-09-30/);
  assert.match(r.text, /Points: 25/);
  assert.match(r.text, /Rubric/);
  assert.match(r.text, /osmosis/); ok('read assignment (due date, points, rubric)');

  r = await call('read', { ref: 'file/502' });
  assert.match(r.text, /Slide 1[\s\S]*Mitochondria/);
  assert.match(r.text, /Krebs cycle & oxidative/);
  assert.match(r.text, /Speaker notes:\s*Remember NADH/);
  assert.match(r.text, /Saved at: .*cells\.pptx/); ok('read pptx (slides, notes, disk path)');

  r = await call('read', { ref: 'file/501' });
  assert.match(r.text, /page 1 ---\s*Photosynthesis converts light/); ok('read pdf text');

  r = await call('read', { ref: 'file/502', limit: 500, offset: 0 });
  r = await call('read', { ref: 'item/2', limit: 500 });
  assert.ok(r.text.length < 1500); ok('read honours limit');

  r = await call('search', { query: 'mitochondria powerhouse' });
  assert.match(r.text, /^1\. cells\.pptx\s+\[File\]/); ok('search ranks the matching file first');

  r = await call('search', { query: 'osmosis' });
  assert.match(r.text, /Lab report 1.*item\/3/); ok('search finds assignments');

  r = await call('search', { query: 'photosynthesis' });
  assert.match(r.text, /lecture1\.pdf/); ok('search finds PDF text');

  r = await call('search', { query: 'zzzznotthere' });
  assert.match(r.text, /No matches/); ok('search reports no matches');

  r = await call('read', { ref: 'item/99999' });
  assert.ok(r.isError); ok('read of an unknown ref is a clean error');

  r = await call('get_module', { module_id: 'nope' });
  assert.ok(r.isError); ok('unknown module is a clean error');

  await client.close();

  // --- removal
  await fetch(`${BASE}/api/module?course=42&module=7`, { method: 'DELETE', headers: EXT });
  const after = (await (await fetch(`${BASE}/api/library`, { headers: EXT })).json()).courses;
  assert.deepEqual(after[0].modules.map((m) => m.id), ['8']);
  assert.ok(!fs.existsSync(path.join(LIB, 'courses/42/files/501')));
  assert.ok(!fs.existsSync(path.join(LIB, 'courses/42/items/2.json'))); ok('removing a module deletes its items and files');

  console.log(`\n${passed} checks passed`);
} catch (e) {
  console.error('\nFAILED:', e);
  process.exitCode = 1;
} finally {
  ingest.close();
  canvas.close();
  fs.rmSync(LIB, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode || 0), 100);
}
