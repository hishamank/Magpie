import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { ExtractedContent } from './types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('extractor:medium');

const FREEDIUM_BASE = 'https://freedium-mirror.cfd';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Extract Medium articles via freedium proxy to bypass paywall.
 * Falls back to direct fetch if freedium fails.
 */
export async function extractMedium(url: string, _sourceMetadata?: Record<string, unknown>): Promise<ExtractedContent> {
  logger.info({ url }, 'Extracting Medium article via freedium');

  // Try freedium first
  try {
    const result = await extractViaFreedium(url);
    if (result.text.length > 200) return result;
    logger.warn({ url, len: result.text.length }, 'Freedium returned too little content, trying direct');
  } catch (err) {
    logger.warn({ url, err }, 'Freedium extraction failed, trying direct');
  }

  // Fallback: direct fetch (may be paywalled but gets whatever's available)
  return extractDirect(url);
}

async function extractViaFreedium(url: string): Promise<ExtractedContent> {
  const freediumUrl = `${FREEDIUM_BASE}/${url}`;

  const response = await fetch(freediumUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Freedium returned HTTP ${response.status}`);
  }

  const html = await response.text();
  const { document } = parseHTML(html);

  // Freedium puts article content in .main-content div
  const mainContent = document.querySelector('.main-content');

  let title = '';
  let text = '';
  let author: string | undefined;

  if (mainContent) {
    // Extract title — try h1 in content, then page title, then og:title
    const h1 = mainContent.querySelector('h1');
    title = h1?.textContent?.trim() || '';
    if (!title) {
      const titleEl = document.querySelector('title');
      title = titleEl?.textContent?.trim() || '';
    }
    if (!title) {
      const ogTitle = document.querySelector('meta[property="og:title"]');
      title = ogTitle?.getAttribute('content')?.trim() || '';
    }

    // Get all text content
    text = (mainContent.textContent || '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  // If .main-content didn't work, try Readability on the full page
  if (!text || text.length < 100) {
    Object.defineProperty(document, 'baseURI', { value: url });
    const reader = new Readability(document as unknown as Document, { charThreshold: 50 });
    const article = reader.parse();

    if (article) {
      title = title || article.title || '';
      text = (article.textContent || '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+/g, ' ')
        .trim();
      author = article.byline || undefined;
    }
  }

  if (!text) {
    throw new Error('Failed to extract content from freedium page');
  }

  // Clean up title: strip " - Freedium" suffix and extract author from "Title | by Author | in Publication" format
  title = title.replace(/\s*-\s*Freedium\s*$/, '');
  const byMatch = title.match(/^(.+?)\s*\|\s*by\s+(.+?)(\s*\|.*)?$/);
  if (byMatch) {
    title = byMatch[1].trim();
    if (!author) author = byMatch[2].trim();
  }

  // Try to extract author from meta tags
  if (!author) {
    const authorEl = document.querySelector('meta[name="author"]');
    author = authorEl?.getAttribute('content') || undefined;
  }

  return {
    title,
    text,
    author,
    metadata: { extractedVia: 'freedium' },
  };
}

async function extractDirect(url: string): Promise<ExtractedContent> {
  logger.info({ url }, 'Trying direct Medium extraction');

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
  Object.defineProperty(document, 'baseURI', { value: url });

  const reader = new Readability(document as unknown as Document, { charThreshold: 100 });
  const article = reader.parse();

  if (!article) {
    throw new Error('Readability failed to parse Medium article');
  }

  const text = (article.textContent || '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  return {
    title: article.title || '',
    text,
    author: article.byline || undefined,
    metadata: { extractedVia: 'direct', possiblyPaywalled: true },
  };
}
