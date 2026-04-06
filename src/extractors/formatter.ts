import TurndownService from 'turndown';

export interface FormatOptions {
  preserveImages?: boolean;
  preserveLinks?: boolean;
  preserveCodeBlocks?: boolean;
  maxLength?: number;
}

/**
 * Shared Turndown instance configured for clean, LLM-friendly markdown.
 */
function createTurndown(options?: FormatOptions): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });

  // Strip navigation, footer, sidebar, ads
  td.remove([
    'nav', 'footer', 'aside',
    'script', 'style', 'noscript',
    'iframe', 'form',
  ]);

  // Strip elements with common boilerplate classes/IDs
  td.addRule('stripBoilerplate', {
    filter: (node) => {
      if (node.nodeType !== 1) return false;
      const el = node as HTMLElement;
      const cls = (el.getAttribute('class') || '').toLowerCase();
      const id = (el.getAttribute('id') || '').toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();

      // Navigation and sidebar roles
      if (['navigation', 'banner', 'contentinfo', 'complementary'].includes(role)) return true;

      // Common boilerplate class/id patterns
      const boilerplate = /sidebar|footer|nav(bar|igation)?|menu|cookie|consent|newsletter|signup|share|social|ad(vert)?[-_]?|related-posts|comments-section/;
      return boilerplate.test(cls) || boilerplate.test(id);
    },
    replacement: () => '',
  });

  // Convert <figure> with <figcaption> to markdown image with alt text
  td.addRule('figure', {
    filter: 'figure',
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const img = el.querySelector('img');
      const caption = el.querySelector('figcaption');
      if (!img) return _content;

      const src = img.getAttribute('src') || '';
      const alt = caption?.textContent?.trim() || img.getAttribute('alt') || '';
      return `\n\n![${alt}](${src})\n\n`;
    },
  });

  if (options?.preserveImages === false) {
    td.addRule('removeImages', {
      filter: 'img',
      replacement: () => '',
    });
  }

  if (options?.preserveLinks === false) {
    td.addRule('removeLinks', {
      filter: 'a',
      replacement: (_content, node) => (node as HTMLElement).textContent || '',
    });
  }

  return td;
}

/**
 * Convert HTML string to clean markdown using Turndown.
 * Resolves relative URLs to absolute using baseUrl.
 */
export function htmlToMarkdown(html: string, baseUrl: string, options?: FormatOptions): string {
  // Resolve relative URLs before conversion
  const resolvedHtml = resolveRelativeUrls(html, baseUrl);

  const td = createTurndown(options);
  let md = td.turndown(resolvedHtml);

  // Post-processing cleanup
  md = md
    .replace(/\n{3,}/g, '\n\n')          // collapse excessive blank lines
    .replace(/^\s+$/gm, '')               // remove whitespace-only lines
    .replace(/\[([^\]]*)\]\(\s*\)/g, '$1') // remove empty links
    .trim();

  if (options?.maxLength && md.length > options.maxLength) {
    md = md.slice(0, options.maxLength) + '\n\n[...truncated]';
  }

  return md;
}

/**
 * Normalize plain text into a clean, readable format.
 * Used by extractors that produce text, not HTML (YouTube, Reddit).
 */
export function textToMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/^\s+$/gm, '')
    .trim();
}

/**
 * Extract image URLs from HTML content.
 * Returns deduped array of absolute URLs.
 */
export function extractImageUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    const src = resolveUrl(match[1], baseUrl);
    if (src && src.startsWith('http')) urls.add(src);
  }
  return [...urls];
}

/**
 * Extract link URLs from HTML content.
 * Returns deduped array of absolute URLs.
 */
export function extractLinkUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  const linkRegex = /<a[^>]+href=["']([^"']+)["']/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = resolveUrl(match[1], baseUrl);
    if (href && href.startsWith('http')) urls.add(href);
  }
  return [...urls];
}

// --- Internal helpers ---

function resolveUrl(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function resolveRelativeUrls(html: string, baseUrl: string): string {
  // Resolve src and href attributes
  return html
    .replace(/(src|href)=["'](?!https?:\/\/|data:|#|mailto:)([^"']+)["']/gi, (_match, attr, path) => {
      const resolved = resolveUrl(path, baseUrl);
      return `${attr}="${resolved}"`;
    });
}
