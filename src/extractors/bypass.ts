import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { ExtractedContent } from './types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('extractor:bypass');

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// --- Issue detection ---

export interface ContentIssue {
  type: 'login-redirect' | 'captcha' | 'cloudflare-challenge';
  detail: string;
}

/**
 * Light checks on raw HTML for obvious access problems.
 * Only flags things we're confident about — no guessing.
 */
export function detectIssues(html: string, responseUrl?: string, originalUrl?: string): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const htmlLower = html.toLowerCase();

  // Login redirect: response URL went to a login/auth page
  if (responseUrl && originalUrl) {
    try {
      const respPath = new URL(responseUrl).pathname.toLowerCase();
      const origHost = new URL(originalUrl).hostname;
      const respHost = new URL(responseUrl).hostname;

      // Redirected to a different host entirely (SSO, auth provider)
      if (respHost !== origHost && /auth|login|sign|account|sso/i.test(respHost)) {
        issues.push({ type: 'login-redirect', detail: `Redirected to auth host: ${respHost}` });
      }

      // Same host but login path
      if (/^\/(login|signin|sign-in|auth|subscribe|register|account|gateway|access)(\b|\/|$)/.test(respPath)) {
        issues.push({ type: 'login-redirect', detail: `Redirected to login path: ${respPath}` });
      }
    } catch {
      // Bad URLs, skip
    }
  }

  // reCAPTCHA / hCaptcha
  if (/recaptcha\/api|google\.com\/recaptcha|grecaptcha/i.test(htmlLower)) {
    issues.push({ type: 'captcha', detail: 'Google reCAPTCHA detected' });
  }
  if (/hcaptcha\.com\/1\/api|h-captcha/i.test(htmlLower)) {
    issues.push({ type: 'captcha', detail: 'hCaptcha detected' });
  }

  // Cloudflare challenge page
  if (/cf-browser-verification|challenge-platform|cf_chl_opt|cf-challenge-running/i.test(htmlLower)) {
    issues.push({ type: 'cloudflare-challenge', detail: 'Cloudflare JS challenge detected' });
  }

  return issues;
}

// --- Bypass strategies ---

/**
 * Try multiple bypass strategies in order.
 * Returns the first one that produces meaningful content, or null.
 */
export async function tryBypass(url: string): Promise<{ content: ExtractedContent; method: string } | null> {
  const strategies: { name: string; fn: (url: string) => Promise<ExtractedContent> }[] = [
    { name: 'google-cache', fn: tryGoogleCache },
    { name: 'archive-org', fn: tryArchiveOrg },
    { name: 'googlebot-ua', fn: tryGooglebotUA },
  ];

  for (const { name, fn } of strategies) {
    try {
      const result = await fn(url);
      if (result.text.length > 200) {
        logger.info({ url, method: name, textLength: result.text.length }, 'Bypass succeeded');
        return { content: result, method: name };
      }
      logger.debug({ url, method: name, textLength: result.text.length }, 'Bypass returned too little content');
    } catch (err) {
      logger.debug({ url, method: name, err }, 'Bypass strategy failed');
    }
  }

  logger.info({ url }, 'All bypass strategies exhausted');
  return null;
}

/**
 * Google webcache — many sites allow Googlebot to index full content.
 */
async function tryGoogleCache(url: string): Promise<ExtractedContent> {
  const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;

  const response = await fetch(cacheUrl, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Google cache returned HTTP ${response.status}`);
  }

  const html = await response.text();
  return parseWithReadability(html, url);
}

/**
 * Archive.org Wayback Machine — check for a cached snapshot.
 */
async function tryArchiveOrg(url: string): Promise<ExtractedContent> {
  // First check if a snapshot exists via the availability API
  const checkResp = await fetch(
    `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
    { signal: AbortSignal.timeout(10_000) }
  );

  if (!checkResp.ok) {
    throw new Error(`Archive.org API returned HTTP ${checkResp.status}`);
  }

  const data = await checkResp.json() as {
    archived_snapshots?: { closest?: { url?: string; available?: boolean } };
  };

  const snapshotUrl = data.archived_snapshots?.closest?.url;
  if (!snapshotUrl || !data.archived_snapshots?.closest?.available) {
    throw new Error('No Archive.org snapshot available');
  }

  const response = await fetch(snapshotUrl, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`Archive.org snapshot returned HTTP ${response.status}`);
  }

  const html = await response.text();
  const result = parseWithReadability(html, url);

  return {
    ...result,
    metadata: { ...result.metadata, archivedUrl: snapshotUrl },
  };
}

/**
 * Fetch with Googlebot user-agent — many soft paywalls serve full content
 * to search engine crawlers to get indexed.
 */
async function tryGooglebotUA(url: string): Promise<ExtractedContent> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': GOOGLEBOT_UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Googlebot fetch returned HTTP ${response.status}`);
  }

  const html = await response.text();

  // Check that the Googlebot response doesn't also have issues
  const issues = detectIssues(html, response.url, url);
  if (issues.length > 0) {
    throw new Error(`Googlebot fetch hit: ${issues.map(i => i.type).join(', ')}`);
  }

  return parseWithReadability(html, url);
}

// --- Shared parser ---

function parseWithReadability(html: string, url: string): ExtractedContent {
  const { document } = parseHTML(html);
  Object.defineProperty(document, 'baseURI', { value: url });

  const reader = new Readability(document as unknown as Document, { charThreshold: 100 });
  const article = reader.parse();

  if (!article) {
    throw new Error('Readability failed to parse bypassed content');
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
  };
}
