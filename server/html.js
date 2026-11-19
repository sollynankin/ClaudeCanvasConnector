import TurndownService from 'turndown';
import gfmPkg from 'turndown-plugin-gfm';

const { gfm } = gfmPkg;

const td = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
});
td.use(gfm);
td.remove(['script', 'style', 'noscript']);
td.addRule('iframe', {
  filter: 'iframe',
  replacement: (_c, node) => {
    const src = node.getAttribute('src') || '';
    return src ? `\n\n[embedded content: ${src}]\n\n` : '';
  },
});
td.addRule('video', {
  filter: ['video', 'audio'],
  replacement: (_c, node) => {
    const src = node.getAttribute('src') || node.querySelector?.('source')?.getAttribute('src') || '';
    return src ? `\n\n[${node.nodeName.toLowerCase()}: ${src}]\n\n` : '';
  },
});

/** Turn site-relative links in Canvas HTML into absolute ones so they stay useful outside Canvas. */
function absolutize(html, origin) {
  if (!origin) return html;
  return html.replace(/\b(href|src)=("|')(\/(?!\/)[^"']*)\2/gi, (_m, attr, q, p) => `${attr}=${q}${origin}${p}${q}`);
}

export function htmlToMarkdown(html, origin) {
  if (!html || typeof html !== 'string') return '';
  try {
    return td
      .turndown(absolutize(html, origin))
      .replace(/ /g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    // Fall back to crude tag stripping so we never lose the text entirely.
    return html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  }
}
