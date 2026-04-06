import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { ExtractedContent } from './types.js';
import { detectIssues, tryBypass } from './bypass.js';
import { logExtraction } from './extraction-log.js';
import { extractMeta } from './meta.js';
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
 * Default handler: fetch → check for issues → bypass if needed → Playwright fallback.
 */
export async function extractDefault(url: string, _sourceMetadata?: Record<string, unknown>): Promise<ExtractedContent> {
  const domain = new URL(url).hostname.replace(/^www\./, '');

  // Step 1: Try Readability fetch
  try {
    const { content, html, responseUrl } = await fetchAndParse(url);
    const issues = detectIssues(html, responseUrl, url);

    if (issues.length === 0 && content.text.length > 200) {
      logExtraction({
        timestamp: new Date().toISOString(),
        url, domain, handler: 'default',
        textLength: content.text.length,
        issues: [],
        bypassUsed: null, bypassSuccess: false,
        finalMethod: 'direct',
      });
      return content;
    }

    // Issues detected or content too short — try bypass
    if (issues.length > 0) {
      logger.warn({ url, issues }, 'Content issues detected, trying bypass');
    }

    const bypass = await tryBypass(url);
    if (bypass) {
      logExtraction({
        timestamp: new Date().toISOString(),
        url, domain, handler: 'default',
        textLength: bypass.content.text.length,
        issues,
        bypassUsed: bypass.method, bypassSuccess: true,
        finalMethod: `bypass:${bypass.method}`,
      });
      return {
        ...bypass.content,
        metadata: { ...bypass.content.metadata, extractedVia: bypass.method, issuesDetected: issues },
      };
    }

    // Bypass failed — return whatever we got from direct fetch if we have anything
    if (content.text.length > 0) {
      logExtraction({
        timestamp: new Date().toISOString(),
        url, domain, handler: 'default',
        textLength: content.text.length,
        issues,
        bypassUsed: null, bypassSuccess: false,
        finalMethod: 'direct-degraded',
      });
      return content;
    }
  } catch (err) {
    logger.warn({ url, err }, 'Readability extraction failed');
  }

  // Step 2: Playwright fallback
  try {
    const result = await extractWithPlaywright(url);
    logExtraction({
      timestamp: new Date().toISOString(),
      url, domain, handler: 'default',
      textLength: result.text.length,
      issues: [],
      bypassUsed: null, bypassSuccess: false,
      finalMethod: 'playwright',
    });
    return result;
  } catch (err) {
    logExtraction({
      timestamp: new Date().toISOString(),
      url, domain, handler: 'default',
      textLength: 0,
      issues: [],
      bypassUsed: null, bypassSuccess: false,
      finalMethod: 'failed',
      error: (err as Error).message,
    });
    throw err;
  }
}

// --- Fetch + parse with issue detection ---

async function fetchAndParse(url: string): Promise<{
  content: ExtractedContent;
  html: string;
  responseUrl: string;
}> {
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
  const responseUrl = response.url; // final URL after redirects

  // Extract meta tags before Readability modifies the DOM
  const meta = extractMeta(html);

  const { document } = parseHTML(html);
  Object.defineProperty(document, 'baseURI', { value: url });

  const reader = new Readability(document as unknown as Document, { charThreshold: 100 });
  const article = reader.parse();

  if (!article) {
    throw new Error('Readability failed to parse article');
  }

  const images: string[] = [];
  const links: string[] = [];

  // Lead with og:image / twitter:image as the primary thumbnail
  const thumbnail = meta.ogImage || meta.twitterImage;
  if (thumbnail) images.push(thumbnail);

  if (article.content) {
    const { document: contentDoc } = parseHTML(article.content);
    for (const img of contentDoc.querySelectorAll('img')) {
      const src = img.getAttribute('src');
      if (src && src !== thumbnail) images.push(src);
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
    content: {
      title: article.title || meta.ogTitle || '',
      text,
      html: article.content || undefined,
      author: article.byline || meta.metaAuthor || undefined,
      images,
      links,
      metadata: {
        ogDescription: meta.ogDescription,
        ogSiteName: meta.ogSiteName,
        ogType: meta.ogType,
        metaKeywords: meta.metaKeywords,
        canonical: meta.canonical,
      },
    },
    html,
    responseUrl,
  };
}

// --- Playwright fallback ---

async function extractWithPlaywright(url: string): Promise<ExtractedContent> {
  logger.info({ url }, 'Fallback extraction with Playwright');

  const browser = await getBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Give JS a moment to render, but don't wait for full network idle
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {
      logger.debug({ url }, 'networkidle not reached within 10s, proceeding with what we have');
    });

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
