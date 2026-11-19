import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as lib from './library.js';
import { startHttp } from './http.js';
import { PORT, LIBRARY_DIR } from './config.js';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

/** Accept an explicit course id, or fall back to the only course in the library. */
function pickCourse(courseId) {
  const courses = lib.listCourses();
  if (!courses.length) throw new Error('The library is empty. Add modules from Canvas with the Chrome extension first.');
  if (courseId) {
    const wanted = String(courseId).trim();
    const exact = courses.find((c) => c.id === wanted);
    if (exact) return exact;
    const byName = courses.filter((c) => `${c.name} ${c.code || ''}`.toLowerCase().includes(wanted.toLowerCase()));
    if (byName.length === 1) return byName[0];
    throw new Error(`No course matches "${courseId}". Courses: ${courses.map((c) => `${c.id} (${c.name})`).join('; ')}`);
  }
  if (courses.length === 1) return courses[0];
  throw new Error(`Several courses are in the library; pass course_id. Courses: ${courses.map((c) => `${c.id} (${c.name})`).join('; ')}`);
}

function pickModule(courseId, moduleId) {
  const modules = lib.listModules(courseId);
  const wanted = String(moduleId).trim();
  const exact = modules.find((m) => m.id === wanted);
  if (exact) return exact;
  const byName = modules.filter((m) => m.name.toLowerCase().includes(wanted.toLowerCase()));
  if (byName.length === 1) return byName[0];
  throw new Error(`No unique module matches "${moduleId}". Modules: ${modules.map((m) => `${m.id} (${m.name})`).join('; ')}`);
}

const server = new McpServer(
  { name: 'canvas-library', version: '0.1.0' },
  {
    instructions:
      'A personal library of Canvas course modules the user saved from their browser. ' +
      'Start with list_courses, then list_modules / get_module to see the outline, then read to open an item or file. ' +
      'Use search to find content across everything. Refs look like item/<id> or file/<id> and come from get_module and search results.',
  },
);

server.registerTool(
  'list_courses',
  { description: 'List the courses in the library with how many modules and items each has.' },
  async () => {
    const courses = lib.listCourses();
    if (!courses.length) return text('The library is empty. Add modules from Canvas using the Chrome extension.');
    return text(
      courses
        .map((c) => `- ${c.id}: ${c.name}${c.code ? ` [${c.code}]` : ''} — ${c.moduleCount} module(s), ${c.itemCount} item(s)`)
        .join('\n'),
    );
  },
);

server.registerTool(
  'list_modules',
  {
    description: 'List the modules saved for a course, in Canvas order.',
    inputSchema: { course_id: z.string().optional().describe('Course id or part of its name. Optional if the library has only one course.') },
  },
  async ({ course_id }) => {
    try {
      const course = pickCourse(course_id);
      const modules = lib.listModules(course.id);
      return text(
        `${course.name} (course ${course.id})\n` +
          modules.map((m) => `- ${m.id}: ${m.name} — ${m.items.length} item(s)`).join('\n'),
      );
    } catch (e) {
      return fail(e.message);
    }
  },
);

server.registerTool(
  'get_module',
  {
    description: 'Show the outline of one module: every item with its type, title and ref to pass to read.',
    inputSchema: {
      module_id: z.string().describe('Module id, or part of the module name.'),
      course_id: z.string().optional().describe('Course id or part of its name. Optional if the library has only one course.'),
    },
  },
  async ({ module_id, course_id }) => {
    try {
      const course = pickCourse(course_id);
      const mod = pickModule(course.id, module_id);
      const lines = [`${mod.name} (module ${mod.id}, course ${course.id}: ${course.name})`, ''];
      for (const it of mod.items) {
        const pad = '  '.repeat(it.indent || 0);
        let extra = '';
        if (it.type === 'SubHeader') {
          lines.push(`${pad}## ${it.title}`);
          continue;
        }
        if (it.type === 'File') {
          const meta = lib.getFileMeta(course.id, it.ref.split('/')[1]);
          extra = meta ? ` — ${lib.describeFile(meta)}` : '';
        } else if (it.type === 'ExternalUrl' || it.type === 'ExternalTool') extra = it.url ? ` — ${it.url}` : '';
        else extra = it.chars ? ` — ${it.chars.toLocaleString()} chars` : ' — no text';
        if (it.linkedFiles) extra += `, ${it.linkedFiles} linked file(s)`;
        if (it.error) extra += ` (import warning: ${it.error})`;
        lines.push(`${pad}- [${it.type}] ${it.title}  →  ${it.ref}${extra}`);
      }
      return text(lines.join('\n'));
    } catch (e) {
      return fail(e.message);
    }
  },
);

server.registerTool(
  'read',
  {
    description:
      'Read one item or file from the library. Long content is paged: use offset to continue where the previous call stopped. ' +
      'For files that were downloaded, the result includes the path of the original on disk.',
    inputSchema: {
      ref: z.string().describe('Ref such as "item/123" or "file/456", taken from get_module or search results.'),
      course_id: z.string().optional().describe('Course id or part of its name. Optional if the library has only one course.'),
      offset: z.number().int().min(0).optional().describe('Character offset to start from (default 0).'),
      limit: z.number().int().min(500).max(100000).optional().describe('Maximum characters to return (default 20000).'),
    },
  },
  async ({ ref, course_id, offset = 0, limit = 20000 }) => {
    try {
      const course = pickCourse(course_id);
      const r = lib.resolveRef(course.id, ref);
      if (!r) return fail(`Nothing found for ${ref} in course ${course.id}. Use get_module or search to find valid refs.`);
      const total = r.body.length;
      const slice = r.body.slice(offset, offset + limit);
      const end = offset + slice.length;
      const out = [`# ${r.title}`, ...r.header];
      if (r.path) out.push(`Saved at: ${r.path}`);
      out.push('', slice);
      if (end < total) out.push('', `[showing characters ${offset}-${end} of ${total}; call read again with offset=${end} for more]`);
      else if (offset > 0) out.push('', `[end — characters ${offset}-${end} of ${total}]`);
      return text(out.join('\n'));
    } catch (e) {
      return fail(e.message);
    }
  },
);

server.registerTool(
  'search',
  {
    description: 'Full-text search across every saved page, assignment, discussion, quiz description and downloaded file. Returns ranked matches with snippets and refs.',
    inputSchema: {
      query: z.string().describe('Words or a phrase to look for.'),
      course_id: z.string().optional().describe('Limit to one course (id or part of its name). Searches all courses if omitted.'),
      limit: z.number().int().min(1).max(30).optional().describe('Maximum results (default 10).'),
    },
  },
  async ({ query, course_id, limit = 10 }) => {
    try {
      const courseId = course_id ? pickCourse(course_id).id : undefined;
      const results = lib.search(query, { courseId, limit });
      if (!results.length) return text(`No matches for "${query}".`);
      return text(
        results
          .map((r, i) => `${i + 1}. ${r.title}  [${r.kind}]  course ${r.courseId}, ${r.ref}${r.module ? `, module: ${r.module}` : ''}\n   ${r.snippet}`)
          .join('\n\n'),
      );
    } catch (e) {
      return fail(e.message);
    }
  },
);

// Best-effort: also host the ingest endpoint the Chrome extension posts to, so Claude being open is
// enough. If another process already holds the port, that one serves the same folder — nothing to do.
startHttp(PORT)
  .then((s) => console.error(s ? `[canvas-library] ingest server on http://127.0.0.1:${PORT}` : `[canvas-library] ingest server already running on port ${PORT}`))
  .catch((e) => console.error('[canvas-library] could not start ingest server:', e.message));

console.error(`[canvas-library] library folder: ${LIBRARY_DIR}`);
await server.connect(new StdioServerTransport());
