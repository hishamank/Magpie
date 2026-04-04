import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { ExtractedContent } from './types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('extractor:default');

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Shared Playwright browser instance
let browserInstance: import('playwright').Browser | null = null;

async function getBrowser(): Promise<import('playwright').Browser> {
  if (!browserInstance) {
    const { chromium } = await import('playwright');
    browserInstance = await chromium.launch({ headless: true });
  }
  return browserInstance;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Default handler: Readability fetch first, Playwright fallback if that fails
 * or returns too little content.
 */
export async function extractDefault(url: string, _sourceMetadata?: Record<string, unknown>): Promise<ExtractedContent> {
  // Try Readability (fast, no browser)
  try {
    const result = await extractWithReadability(url);
    if (result.text.length > 200) return result;
    logger.warn({ url, len: result.text.length }, 'Readability returned too little content, trying Playwright');
  } catch (err) {
    logger.warn({ url, err }, 'Readability extraction failed, trying Playwright');
  }

  // Fallback to Playwright
  return extractWithPlaywright(url);
}

async function extractWithReadability(url: string): Promise<ExtractedContent> {
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
    throw new Error('Readability failed to parse article');
  }

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

  const text = (article.textContent || '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  return {
    title: article.title || '',
    text,
    html: article.content || undefined,
    author: article.byline || undefined,
    images,
    links,
  };
}

async function extractWithPlaywright(url: string): Promise<ExtractedContent> {
  logger.info({ url }, 'Fallback extraction with Playwright');

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    const html = await page.content();

    const { document } = parseHTML(html);
    Object.defineProperty(document, 'baseURI', { value: url });

    const reader = new Readability(document as unknown as Document, { charThreshold: 50 });
    const article = reader.parse();

    if (!article) {
      const bodyText = await page.evaluate(() => document.body.innerText);
      return {
        title: await page.title(),
        text: bodyText.replace(/\n{3,}/g, '\n\n').trim(),
      };
    }

    const text = (article.textContent || '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();

    return {
      title: article.title || await page.title(),
      text,
      html: article.content || undefined,
      author: article.byline || undefined,
    };
  } finally {
    await page.close();
  }
}
