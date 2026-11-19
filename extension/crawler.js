/*
 * Canvas crawler. Runs inside the Canvas page (content script) so every request is same-origin and
 * uses the student's existing login — no API token needed. Also loadable from Node for tests.
 */
(function (root) {
  'use strict';

  const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
  const CHUNK_BYTES = 768 * 1024;
  const MAX_LINKED_FILES_PER_ITEM = 40;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function toBase64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function findFileIds(html) {
    const ids = new Set();
    for (const m of String(html || '').matchAll(/\/files\/(\d+)/g)) ids.add(m[1]);
    return [...ids];
  }

  function createApi({ origin, fetchImpl }) {
    const doFetch = fetchImpl || ((u, o) => root.fetch(u, o));
    const abs = (p) => (/^https?:/i.test(p) ? p : origin + p);

    async function request(path, init = {}) {
      let res;
      for (let attempt = 0; attempt < 4; attempt++) {
        res = await doFetch(abs(path), { credentials: 'same-origin', ...init });
        // Canvas signals throttling with 429, or 403 + "Rate Limit Exceeded".
        const throttled = res.status === 429 || (res.status === 403 && /rate limit/i.test(await res.clone().text().catch(() => '')));
        if (!throttled) return res;
        await sleep(800 * 2 ** attempt);
      }
      return res;
    }

    async function json(path) {
      const res = await request(path, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${path.split('?')[0]}`), { status: res.status });
      const body = (await res.text()).replace(/^while\(1\);/, '');
      return { data: JSON.parse(body), link: res.headers.get('Link') || '' };
    }

    async function all(path) {
      const out = [];
      let next = path;
      for (let page = 0; next && page < 100; page++) {
        const { data, link } = await json(next);
        if (Array.isArray(data)) out.push(...data);
        else return data;
        next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] || null;
      }
      return out;
    }

    async function getCourse(cid) {
      const c = (await json(`/api/v1/courses/${cid}?include[]=term`)).data;
      return { id: String(c.id), name: c.name, code: c.course_code, term: c.term?.name || null };
    }

    async function listModules(cid) {
      const mods = await all(`/api/v1/courses/${cid}/modules?per_page=100`);
      return mods.map((m) => ({ id: String(m.id), name: m.name, position: m.position, itemsCount: m.items_count ?? null, published: m.published }));
    }

    async function fetchFileMeta(id) {
      return (await json(`/api/v1/files/${id}`)).data;
    }

    async function crawlModule(cid, mod, { onProgress } = {}) {
      const raw = await all(`/api/v1/courses/${cid}/modules/${mod.id}/items?include[]=content_details&per_page=100`);
      const files = new Map();
      const warnings = [];
      const items = [];

      const addFile = async (id, fallback) => {
        if (files.has(String(id))) return String(id);
        try {
          const f = await fetchFileMeta(id);
          files.set(String(f.id), f);
        } catch (e) {
          if (!fallback) throw e;
          files.set(String(id), fallback);
          warnings.push(`File ${fallback.display_name || id}: ${e.message} (metadata only)`);
        }
        return String(id);
      };

      for (let i = 0; i < raw.length; i++) {
        const it = raw[i];
        onProgress?.(`${mod.name}: reading ${i + 1}/${raw.length} — ${it.title}`);
        const out = {
          id: it.id,
          type: it.type,
          title: it.title,
          indent: it.indent,
          position: it.position,
          html_url: it.html_url,
          external_url: it.external_url,
          content_id: it.content_id,
          info: {},
          fileIds: [],
        };
        try {
          switch (it.type) {
            case 'Page': {
              const p = (await json(`/api/v1/courses/${cid}/pages/${encodeURIComponent(it.page_url)}`)).data;
              out.html = p.body || '';
              out.info.updated_at = p.updated_at;
              break;
            }
            case 'Assignment': {
              const a = (await json(`/api/v1/courses/${cid}/assignments/${it.content_id}`)).data;
              out.html = a.description || '';
              Object.assign(out.info, {
                due_at: a.due_at,
                unlock_at: a.unlock_at,
                lock_at: a.lock_at,
                points_possible: a.points_possible,
                submission_types: a.submission_types,
                rubric: a.rubric,
                updated_at: a.updated_at,
              });
              break;
            }
            case 'Discussion': {
              const d = (await json(`/api/v1/courses/${cid}/discussion_topics/${it.content_id}`)).data;
              out.html = d.message || '';
              out.info.updated_at = d.last_reply_at || d.posted_at;
              break;
            }
            case 'Quiz': {
              const q = (await json(`/api/v1/courses/${cid}/quizzes/${it.content_id}`)).data;
              out.html = q.description || '';
              Object.assign(out.info, {
                due_at: q.due_at,
                unlock_at: q.unlock_at,
                lock_at: q.lock_at,
                points_possible: q.points_possible,
                question_count: q.question_count,
                time_limit: q.time_limit,
              });
              break;
            }
            case 'File': {
              const cd = it.content_details || {};
              await addFile(it.content_id, {
                id: it.content_id,
                display_name: it.title,
                size: cd.size,
                'content-type': cd['content-type'] || cd.content_type,
                url: cd.url,
                modified_at: cd.updated_at,
              });
              break;
            }
            default:
              break; // SubHeader, ExternalUrl, ExternalTool: nothing to fetch
          }
        } catch (e) {
          out.error = e.message;
          warnings.push(`${it.title}: ${e.message}`);
        }

        // Files linked from inside the item's HTML (slides, PDFs, handouts…).
        if (out.html) {
          for (const fid of findFileIds(out.html).slice(0, MAX_LINKED_FILES_PER_ITEM)) {
            try {
              out.fileIds.push(await addFile(fid));
            } catch {
              /* link to something we cannot access (other course, deleted): ignore */
            }
          }
        }
        items.push(out);
      }
      return { items, files: [...files.values()], warnings };
    }

    async function download(meta, maxBytes) {
      if (meta.size != null && meta.size > maxBytes) throw new Error(`larger than ${Math.round(maxBytes / 1048576)} MB limit`);
      const urls = [meta.url, `/files/${meta.id}/download?download_frd=1`].filter(Boolean);
      let lastError = new Error('no download url');
      for (const u of urls) {
        try {
          const res = await request(u, { redirect: 'follow' });
          if (res.ok) return new Uint8Array(await res.arrayBuffer());
          lastError = new Error(`HTTP ${res.status}`);
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError;
    }

    return { getCourse, listModules, crawlModule, download };
  }

  /**
   * Import chosen modules into the library.
   * `post(path, body)` delivers JSON to the local server and resolves with its JSON reply.
   */
  async function runImport({ api, origin, courseId, moduleIds, withFiles = true, post, onProgress, maxFileBytes = DEFAULT_MAX_FILE_BYTES }) {
    const say = (m, extra) => onProgress?.(m, extra);
    const wanted = new Set(moduleIds.map(String));
    say('Reading course…');
    const course = await api.getCourse(courseId);
    const modules = (await api.listModules(courseId)).filter((m) => wanted.has(m.id));
    if (!modules.length) throw new Error('None of the selected modules were found in this course.');

    const summary = { modules: 0, items: 0, files: 0, downloaded: 0, notDownloaded: [], warnings: [] };
    for (const mod of modules) {
      const crawl = await api.crawlModule(courseId, mod, { onProgress: say });
      summary.warnings.push(...crawl.warnings);
      const saved = await post('/api/module', { course, module: mod, origin, items: crawl.items, files: crawl.files });
      summary.modules++;
      summary.items += crawl.items.length;
      summary.files += crawl.files.length;

      if (!withFiles) continue;
      const byId = new Map(crawl.files.map((f) => [String(f.id), f]));
      const need = saved.needFiles || [];
      for (let i = 0; i < need.length; i++) {
        const meta = byId.get(String(need[i]));
        if (!meta) continue;
        const label = meta.display_name || meta.filename || meta.id;
        say(`${mod.name}: downloading file ${i + 1}/${need.length} — ${label}`);
        try {
          const bytes = await api.download(meta, maxFileBytes);
          const uploadId = `${courseId}-${meta.id}-${Date.now()}`;
          const n = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
          for (let c = 0; c < n; c++) {
            await post('/api/file-chunk', {
              uploadId,
              index: c,
              last: c === n - 1,
              courseId,
              fileId: meta.id,
              name: label,
              contentType: meta['content-type'],
              data: toBase64(bytes.subarray(c * CHUNK_BYTES, (c + 1) * CHUNK_BYTES)),
            });
          }
          summary.downloaded++;
        } catch (e) {
          summary.notDownloaded.push(`${label}: ${e.message}`);
          await post('/api/file-note', { courseId, fileId: meta.id, note: `not downloaded: ${e.message}` }).catch(() => {});
        }
      }
    }
    return summary;
  }

  const api = { createApi, runImport, findFileIds, toBase64 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CanvasLibraryCrawler = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
