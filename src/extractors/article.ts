import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { Extractor, ExtractedContent } from './types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('extractor:article');

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export class ArticleExtractor implements Extractor {
  async extract(url: string, _sourceMetadata?: Record<string, unknown>): Promise<ExtractedContent> {
    logger.info({ url }, 'Extracting article');

    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${url}`);
    }

    const html = await response.text();
    const { document } = parseHTML(html);

    // Set the document URL for relative URL resolution
    Object.defineProperty(document, 'baseURI', { value: url });

    const reader = new Readability(document as unknown as Document, { charThreshold: 100 });
    const article = reader.parse();

    if (!article) {
      throw new Error('Readability failed to parse article — will try fallback');
    }

    // Extract images and links from the content HTML
    const images: string[] = [];
    const links: string[] = [];

    if (article.content) {
      const { document: contentDoc } = parseHTML(article.content);
      for (const img of contentDoc.querySelectorAll('img')) {
        const src = img.getAttribute('src');
        if (src) images.push(src);
      }
      for (const a of contentDoc.querySelectorAll('a')) {
        const href = a.getAttribute('href');
        if (href && href.startsWith('http')) links.push(href);
      }
    }

    // Clean text: normalize whitespace
    const text = (article.textContent || '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();

    logger.info({ url, titleLength: article.title?.length, textLength: text.length }, 'Article extracted');

    return {
      title: article.title || '',
      text,
      html: article.content || undefined,
      author: article.byline || undefined,
      images,
      links,
    };
  }
}
