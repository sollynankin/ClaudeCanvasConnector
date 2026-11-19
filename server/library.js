import fs from 'node:fs';
import path from 'node:path';
import { LIBRARY_DIR } from './config.js';
import { htmlToMarkdown } from './html.js';
import { extractText } from './extract.js';

/* ------------------------------------------------------------------ paths */

export function safeId(id) {
  const s = String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!s) throw new Error(`invalid id: ${JSON.stringify(id)}`);
  return s;
}

function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return (base || 'file').slice(0, 150);
}

const coursesRoot = () => path.join(LIBRARY_DIR, 'courses');
const courseDir = (cid) => path.join(coursesRoot(), safeId(cid));
const modulesDir = (cid) => path.join(courseDir(cid), 'modules');
const itemsDir = (cid) => path.join(courseDir(cid), 'items');
const filesDir = (cid) => path.join(courseDir(cid), 'files');
export const tmpDir = () => path.join(LIBRARY_DIR, '.tmp');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

function listFiles(dir, ext) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith(ext));
  } catch {
    return [];
  }
}

/* ----------------------------------------------------------------- writing */

function renderRubric(rubric) {
  if (!Array.isArray(rubric) || !rubric.length) return '';
  const lines = ['## Rubric'];
  for (const c of rubric) {
    lines.push(`- **${c.description || 'Criterion'}** (${c.points ?? '?'} pts)${c.long_description ? ` — ${c.long_description}` : ''}`);
    for (const r of c.ratings || []) lines.push(`  - ${r.points} pts: ${r.description || ''}${r.long_description ? ` — ${r.long_description}` : ''}`);
  }
  return lines.join('\n');
}

function buildItemRecord(item, moduleId, origin) {
  const info = item.info || {};
  let markdown = htmlToMarkdown(item.html, origin);
  if (item.text && !markdown) markdown = String(item.text);
  const rubric = renderRubric(info.rubric);
  if (rubric) markdown = `${markdown}\n\n${rubric}`.trim();
  return {
    id: String(item.id),
    moduleId: String(moduleId),
    type: item.type || 'Unknown',
    title: item.title || '(untitled)',
    indent: item.indent ?? 0,
    position: item.position ?? 0,
    url: item.html_url || null,
    externalUrl: item.external_url || null,
    contentId: item.content_id != null ? String(item.content_id) : null,
    fileId: item.type === 'File' && item.content_id != null ? String(item.content_id) : null,
    linkedFileIds: (item.fileIds || []).map(String),
    dueAt: info.due_at || null,
    unlockAt: info.unlock_at || null,
    lockAt: info.lock_at || null,
    points: info.points_possible ?? null,
    submissionTypes: info.submission_types || null,
    questionCount: info.question_count ?? null,
    timeLimit: info.time_limit ?? null,
    updatedAt: info.updated_at || null,
    error: item.error || null,
    markdown,
  };
}

export function saveModule({ course, module, items = [], files = [], origin }) {
  const cid = safeId(course.id);
  const mid = safeId(module.id);
  const now = new Date().toISOString();
  origin = origin || course.domain || '';

  const courseFile = path.join(courseDir(cid), 'course.json');
  const prevCourse = readJson(courseFile, {});
  writeJson(courseFile, {
    id: cid,
    name: course.name || prevCourse.name || `Course ${cid}`,
    code: course.code || prevCourse.code || null,
    term: course.term || prevCourse.term || null,
    domain: origin || prevCourse.domain || null,
    addedAt: prevCourse.addedAt || now,
    updatedAt: now,
  });

  // Drop items from an earlier import of this module that no longer exist.
  const keep = new Set(items.map((i) => String(i.id)));
  for (const f of listFiles(itemsDir(cid), '.json')) {
    const rec = readJson(path.join(itemsDir(cid), f));
    if (rec?.moduleId === mid && !keep.has(rec.id)) fs.rmSync(path.join(itemsDir(cid), f), { force: true });
  }

  const summaries = [];
  for (const raw of items) {
    const rec = buildItemRecord(raw, mid, origin);
    writeJson(path.join(itemsDir(cid), `${safeId(rec.id)}.json`), rec);
    summaries.push({
      id: rec.id,
      type: rec.type,
      title: rec.title,
      indent: rec.indent,
      position: rec.position,
      ref: rec.fileId ? `file/${rec.fileId}` : `item/${rec.id}`,
      chars: rec.markdown.length,
      linkedFiles: rec.linkedFileIds.length,
      url: rec.externalUrl || rec.url,
      error: rec.error,
    });
  }

  const modFile = path.join(modulesDir(cid), `${mid}.json`);
  const prevMod = readJson(modFile, {});
  writeJson(modFile, {
    id: mid,
    name: module.name || `Module ${mid}`,
    position: module.position ?? 0,
    addedAt: prevMod.addedAt || now,
    updatedAt: now,
    items: summaries,
  });

  // Register file metadata; keep any bytes we already have if the file is unchanged.
  const needFiles = [];
  for (const f of files) {
    if (f?.id == null) continue;
    const fid = safeId(f.id);
    const metaFile = path.join(filesDir(cid), fid, 'meta.json');
    const prev = readJson(metaFile, null);
    const unchanged = prev?.stored && (prev.size === (f.size ?? prev.size)) && (!f.modified_at || !prev.modifiedAt || prev.modifiedAt === f.modified_at);
    const modules = new Set(prev?.modules || []);
    modules.add(mid);
    const meta = {
      id: fid,
      name: f.display_name || f.filename || prev?.name || `file-${fid}`,
      contentType: f['content-type'] || f.content_type || prev?.contentType || null,
      size: f.size ?? prev?.size ?? null,
      modifiedAt: f.modified_at || prev?.modifiedAt || null,
      url: f.url ? String(f.url).replace(/([?&])verifier=[^&]*&?/, '$1').replace(/[?&]$/, '') : prev?.url || null,
      modules: [...modules],
      stored: unchanged ? true : false,
      storedName: unchanged ? prev.storedName : null,
      textChars: unchanged ? prev.textChars : 0,
      note: unchanged ? prev.note ?? null : null,
      addedAt: prev?.addedAt || now,
    };
    writeJson(metaFile, meta);
    if (!meta.stored) needFiles.push(fid);
  }

  return { courseId: cid, moduleId: mid, items: summaries.length, files: files.length, needFiles };
}

export async function saveFileBytes(courseId, fileId, buffer, { name, contentType } = {}) {
  const cid = safeId(courseId);
  const fid = safeId(fileId);
  const dir = path.join(filesDir(cid), fid);
  const metaFile = path.join(dir, 'meta.json');
  const meta = readJson(metaFile, null) || { id: fid, modules: [], addedAt: new Date().toISOString() };
  if (name) meta.name = name;
  if (contentType) meta.contentType = contentType;
  const storedName = safeName(meta.name || `file-${fid}`);
  if (meta.storedName && meta.storedName !== storedName) fs.rmSync(path.join(dir, meta.storedName), { force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, storedName), buffer);
  const { text, error } = await extractText(buffer, meta.name, meta.contentType);
  if (text) fs.writeFileSync(path.join(dir, 'text.txt'), text);
  else fs.rmSync(path.join(dir, 'text.txt'), { force: true });
  meta.size = meta.size ?? buffer.length;
  meta.stored = true;
  meta.storedName = storedName;
  meta.textChars = text.length;
  meta.note = error ? `text extraction failed: ${error}` : text ? null : 'no extractable text (image, video, scanned PDF or unsupported format)';
  writeJson(metaFile, meta);
  return { fileId: fid, textChars: text.length, note: meta.note };
}

export function noteFile(courseId, fileId, note) {
  const metaFile = path.join(filesDir(courseId), safeId(fileId), 'meta.json');
  const meta = readJson(metaFile, null);
  if (!meta) return;
  meta.note = note;
  writeJson(metaFile, meta);
}

export function removeModule(courseId, moduleId) {
  const cid = safeId(courseId);
  const mid = safeId(moduleId);
  fs.rmSync(path.join(modulesDir(cid), `${mid}.json`), { force: true });
  for (const f of listFiles(itemsDir(cid), '.json')) {
    const rec = readJson(path.join(itemsDir(cid), f));
    if (rec?.moduleId === mid) fs.rmSync(path.join(itemsDir(cid), f), { force: true });
  }
  for (const fid of listDirs(filesDir(cid))) {
    const metaFile = path.join(filesDir(cid), fid, 'meta.json');
    const meta = readJson(metaFile);
    if (!meta) continue;
    meta.modules = (meta.modules || []).filter((m) => m !== mid);
    if (meta.modules.length === 0) fs.rmSync(path.join(filesDir(cid), fid), { recursive: true, force: true });
    else writeJson(metaFile, meta);
  }
  if (listFiles(modulesDir(cid), '.json').length === 0) fs.rmSync(courseDir(cid), { recursive: true, force: true });
}

export function removeCourse(courseId) {
  fs.rmSync(courseDir(courseId), { recursive: true, force: true });
}

/* ----------------------------------------------------------------- reading */

export function listCourses() {
  return listDirs(coursesRoot())
    .map((cid) => {
      const course = readJson(path.join(courseDir(cid), 'course.json'));
      if (!course) return null;
      const modules = listFiles(modulesDir(cid), '.json').map((f) => readJson(path.join(modulesDir(cid), f))).filter(Boolean);
      return { ...course, moduleCount: modules.length, itemCount: modules.reduce((n, m) => n + m.items.length, 0) };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function listModules(courseId) {
  const cid = safeId(courseId);
  return listFiles(modulesDir(cid), '.json')
    .map((f) => readJson(path.join(modulesDir(cid), f)))
    .filter(Boolean)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

export function getModule(courseId, moduleId) {
  return readJson(path.join(modulesDir(courseId), `${safeId(moduleId)}.json`));
}

export function getCourse(courseId) {
  return readJson(path.join(courseDir(courseId), 'course.json'));
}

export function listFileMetas(courseId) {
  const cid = safeId(courseId);
  return listDirs(filesDir(cid)).map((fid) => readJson(path.join(filesDir(cid), fid, 'meta.json'))).filter(Boolean);
}

export function getFileMeta(courseId, fileId) {
  return readJson(path.join(filesDir(courseId), safeId(fileId), 'meta.json'));
}

export function fileDiskPath(courseId, meta) {
  return meta?.storedName ? path.join(filesDir(courseId), safeId(meta.id), meta.storedName) : null;
}

function moduleNameMap(cid) {
  return new Map(listModules(cid).map((m) => [m.id, m.name]));
}

/**
 * Resolve a ref (`item/<id>` or `file/<id>`) to readable text.
 * Returns { title, kind, header, body, path } or null.
 */
export function resolveRef(courseId, ref) {
  const cid = safeId(courseId);
  const m = String(ref).match(/^(item|file)[/:](\d+)$/i);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const id = m[2];
  const names = moduleNameMap(cid);

  if (kind === 'item') {
    const rec = readJson(path.join(itemsDir(cid), `${id}.json`));
    if (!rec) return null;
    const header = [
      `Type: ${rec.type}`,
      `Module: ${names.get(rec.moduleId) || rec.moduleId}`,
      rec.url ? `Canvas link: ${rec.url}` : null,
      rec.externalUrl ? `External link: ${rec.externalUrl}` : null,
      rec.dueAt ? `Due: ${rec.dueAt}` : null,
      rec.points != null ? `Points: ${rec.points}` : null,
      rec.submissionTypes?.length ? `Submission types: ${rec.submissionTypes.join(', ')}` : null,
      rec.questionCount != null ? `Questions: ${rec.questionCount}` : null,
      rec.timeLimit ? `Time limit: ${rec.timeLimit} min` : null,
      rec.error ? `Import warning: ${rec.error}` : null,
    ].filter(Boolean);
    let body = rec.markdown || '(no text content)';
    if (rec.linkedFileIds.length) {
      const lines = rec.linkedFileIds.map((fid) => {
        const meta = getFileMeta(cid, fid);
        return meta ? `- file/${fid}: ${meta.name} (${describeFile(meta)})` : `- file/${fid}`;
      });
      body += `\n\n## Files linked from this item\n${lines.join('\n')}`;
    }
    return { kind, id, title: rec.title, header, body, path: null };
  }

  const meta = getFileMeta(cid, id);
  if (!meta) return null;
  const textFile = path.join(filesDir(cid), id, 'text.txt');
  let body;
  if (fs.existsSync(textFile)) body = fs.readFileSync(textFile, 'utf8');
  else if (meta.stored) body = `(no extractable text — ${meta.note || 'binary file'}. The original is saved on disk; open it directly if it is an image or scanned document.)`;
  else body = `(file bytes were not imported${meta.note ? `: ${meta.note}` : ''}. Re-add the module with "download files" enabled${meta.url ? ` or open ${meta.url}` : ''}.)`;
  const header = [
    `Type: File (${meta.contentType || 'unknown type'}, ${meta.size != null ? formatBytes(meta.size) : 'unknown size'})`,
    `Module(s): ${(meta.modules || []).map((x) => names.get(x) || x).join(', ') || 'unknown'}`,
    meta.stored ? null : 'Bytes not downloaded',
    meta.url ? `Canvas link: ${meta.url}` : null,
  ].filter(Boolean);
  return { kind, id, title: meta.name, header, body, path: fileDiskPath(cid, meta) };
}

export function describeFile(meta) {
  const parts = [];
  if (meta.contentType) parts.push(meta.contentType);
  if (meta.size != null) parts.push(formatBytes(meta.size));
  if (!meta.stored) parts.push('not downloaded');
  else if (meta.textChars) parts.push(`${meta.textChars.toLocaleString()} chars of text`);
  else parts.push('no extractable text');
  return parts.join(', ');
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ search */

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'be', 'by', 'with', 'as', 'at', 'it', 'this', 'that']);

function tokenize(q) {
  return (String(q).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter((t) => t.length > 1 && !STOP.has(t));
}

function countOccurrences(hay, needle) {
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

function snippet(text, lower, terms, width = 220) {
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return text.slice(0, width).replace(/\s+/g, ' ');
  const start = Math.max(0, at - width / 3);
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}

export function search(query, { courseId, limit = 10 } = {}) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const phrase = String(query).toLowerCase().trim();
  const results = [];
  const cids = courseId ? [safeId(courseId)] : listDirs(coursesRoot());

  for (const cid of cids) {
    const course = getCourse(cid);
    if (!course) continue;
    const names = moduleNameMap(cid);

    const consider = (ref, kind, title, text, moduleLabel) => {
      const lowerText = text.toLowerCase();
      const lowerTitle = title.toLowerCase();
      let score = 0;
      let matched = 0;
      for (const t of terms) {
        const inTitle = countOccurrences(lowerTitle, t);
        const inText = countOccurrences(lowerText, t);
        if (inTitle || inText) matched++;
        score += inTitle * 8 + Math.min(inText, 12) * (1 + Math.min(t.length, 8) / 8);
      }
      if (!matched) return;
      score *= 0.5 + matched / terms.length; // reward documents that hit more distinct terms
      if (terms.length > 1 && (lowerText.includes(phrase) || lowerTitle.includes(phrase))) score *= 1.8;
      results.push({
        courseId: cid,
        courseName: course.name,
        ref,
        kind,
        title,
        module: moduleLabel,
        score,
        snippet: snippet(text, lowerText, terms),
      });
    };

    for (const f of listFiles(itemsDir(cid), '.json')) {
      const rec = readJson(path.join(itemsDir(cid), f));
      if (!rec || rec.fileId) continue; // file-type items are covered by the file itself
      consider(`item/${rec.id}`, rec.type, rec.title, rec.markdown || '', names.get(rec.moduleId));
    }
    for (const meta of listFileMetas(cid)) {
      const textFile = path.join(filesDir(cid), meta.id, 'text.txt');
      const text = fs.existsSync(textFile) ? fs.readFileSync(textFile, 'utf8') : '';
      consider(`file/${meta.id}`, 'File', meta.name, text, (meta.modules || []).map((m) => names.get(m) || m).join(', '));
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/* ----------------------------------------------------- management summary */

/** Compact view used by the extension (to mark modules already added) and the web UI. */
export function librarySummary() {
  return listCourses().map((c) => ({
    id: c.id,
    name: c.name,
    code: c.code,
    domain: c.domain,
    modules: listModules(c.id).map((m) => ({ id: m.id, name: m.name, items: m.items.length, updatedAt: m.updatedAt })),
    files: Object.fromEntries(listFileMetas(c.id).map((f) => [f.id, { size: f.size, stored: !!f.stored, modifiedAt: f.modifiedAt }])),
  }));
}
