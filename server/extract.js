import path from 'node:path';
import JSZip from 'jszip';
import { htmlToMarkdown } from './html.js';

const MAX_TEXT = 8 * 1024 * 1024;

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.log', '.rtf',
  '.py', '.js', '.ts', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php',
  '.sql', '.r', '.m', '.tex', '.bib', '.ipynb', '.sh', '.bat', '.ini', '.cfg', '.toml', '.srt', '.vtt',
]);

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** Pull paragraphs of text out of an OOXML part (<a:t>/<w:t> runs, paragraph ends). */
function ooxmlText(xml, runTag, paraTag) {
  const paras = xml.split(new RegExp(`</${paraTag}>`));
  const out = [];
  const runRe = new RegExp(`<${runTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${runTag}>`, 'g');
  for (const p of paras) {
    let line = '';
    for (const m of p.matchAll(runRe)) line += decodeXml(m[1]);
    if (line.trim()) out.push(line);
  }
  return out.join('\n');
}

async function pptxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const num = (name) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  const parts = [];
  for (const name of slides) {
    const n = num(name);
    const text = ooxmlText(await zip.file(name).async('string'), 'a:t', 'a:p');
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
    const notes = notesFile ? ooxmlText(await notesFile.async('string'), 'a:t', 'a:p') : '';
    let part = `## Slide ${n}\n${text}`;
    if (notes) part += `\n\nSpeaker notes:\n${notes}`;
    parts.push(part);
  }
  return parts.join('\n\n');
}

async function xlsxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const sharedFile = zip.file('xl/sharedStrings.xml');
  const shared = [];
  if (sharedFile) {
    const xml = await sharedFile.async('string');
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      let s = '';
      for (const t of m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += decodeXml(t[1]);
      shared.push(s);
    }
  }
  const sheets = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  const parts = [];
  for (const name of sheets) {
    const xml = await zip.file(name).async('string');
    const rows = [];
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const v = c[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const inline = c[2]?.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/)?.[1];
        let val = '';
        if (/t="s"/.test(attrs) && v != null) val = shared[Number(v)] ?? '';
        else if (inline != null) val = decodeXml(inline);
        else if (v != null) val = decodeXml(v);
        cells.push(val);
      }
      if (cells.some((x) => x !== '')) rows.push(cells.join('\t'));
    }
    parts.push(`## ${path.basename(name, '.xml')}\n${rows.join('\n')}`);
  }
  return parts.join('\n\n');
}

async function pdfText(buffer) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text)];
  return pages.map((t, i) => `--- page ${i + 1} ---\n${t.trim()}`).join('\n\n');
}

/**
 * Best-effort text extraction. Returns { text, error } — text is '' when the format has no
 * extractable text (images, video, zips, scanned PDFs, legacy .doc/.ppt).
 */
export async function extractText(buffer, filename = '', contentType = '') {
  const ext = path.extname(filename).toLowerCase();
  const ct = (contentType || '').toLowerCase();
  try {
    let text = '';
    if (ext === '.pdf' || ct === 'application/pdf') text = await pdfText(buffer);
    else if (ext === '.docx') {
      const mammoth = (await import('mammoth')).default;
      text = (await mammoth.extractRawText({ buffer })).value;
    } else if (ext === '.pptx') text = await pptxText(buffer);
    else if (ext === '.xlsx') text = await xlsxText(buffer);
    else if (ext === '.html' || ext === '.htm' || ct === 'text/html') text = htmlToMarkdown(buffer.toString('utf8'));
    else if (TEXT_EXT.has(ext) || ct.startsWith('text/')) text = buffer.toString('utf8');
    text = text.replace(/\u0000/g, '').trim();
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '\n\n[text truncated]';
    return { text, error: null };
  } catch (e) {
    return { text: '', error: String(e?.message || e) };
  }
}
