import type { LegacyHandler, ExtractionResult, ExtractionStatus } from './types.js';
import { extractDefault, closeBrowser } from './default.js';
import { extractYouTube } from './youtube.js';
import { extractTwitter } from './twitter.js';
import { extractMedium } from './medium.js';
import { extractGitHub } from './github.js';
import { extractPdf } from './pdf.js';
import { extractReddit } from './reddit.js';
import { logExtraction } from './extraction-log.js';
import { getDb } from '../db/connection.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('extractor:registry');

// Patterns that indicate content is permanently gone
const UNAVAILABLE_PATTERNS = [
  /video unavailable/i,
  /private video/i,
  /video has been removed/i,
  /account.*terminated/i,
  /this tweet.*deleted/i,
  /this post.*unavailable/i,
  /HTTP 404/i,
  /HTTP 410/i,
  /page not found/i,
  /content.*not available/i,
];

function classifyError(message: string): { status: ExtractionStatus; retryAfter?: number } {
  // Rate limiting
  if (/429|rate.?limit/i.test(message)) {
    const retryMatch = message.match(/retry.?after:?\s*(\d+)/i);
    return { status: 'rate_limited', retryAfter: retryMatch ? parseInt(retryMatch[1]) : 300 };
  }

  // Permanently unavailable
  if (UNAVAILABLE_PATTERNS.some(p => p.test(message))) {
    return { status: 'content_removed' };
  }

  return { status: 'error' };
}

/**
 * Wrap a legacy handler (returns ExtractedContent) into one that returns ExtractionResult.
 */
function wrapLegacyHandler(handler: LegacyHandler): (url: string, sourceMetadata?: Record<string, unknown>) => Promise<ExtractionResult> {
  return async (url, sourceMetadata) => {
    try {
      const content = await handler(url, sourceMetadata);
      return { status: 'success', content };
    } catch (err) {
      const message = (err as Error).message || '';
      const { status, retryAfter } = classifyError(message);
      return { status, content: null, statusDetail: message, retryAfter };
    }
  };
}

// Domain → handler mapping
const handlers = new Map<string, { handler: (url: string, sourceMetadata?: Record<string, unknown>) => Promise<ExtractionResult>; name: string }>();

function register(domains: string[], handler: LegacyHandler, name: string): void {
  const wrapped = wrapLegacyHandler(handler);
  for (const d of domains) handlers.set(d, { handler: wrapped, name });
}

// Register all service handlers
register(['youtube.com', 'youtu.be'], extractYouTube, 'youtube');
register(['twitter.com', 'x.com'], extractTwitter, 'twitter');
register(['github.com'], extractGitHub, 'github');
register(['reddit.com', 'old.reddit.com', 'np.reddit.com'], extractReddit, 'reddit');
register([
  'medium.com',
  'towardsdatascience.com',
  'betterprogramming.pub',
  'levelup.gitconnected.com',
  'javascript.plainenglish.io',
  'blog.stackademic.com',
  'netflixtechblog.com',
  'engineering.atspotify.com',
  'aws.plainenglish.io',
], extractMedium, 'medium');

/**
 * Resolve a URL to its handler by matching the domain.
 * Falls back to default handler and tracks unhandled domains.
 */
function getHandler(url: string): { handler: (url: string, sourceMetadata?: Record<string, unknown>) => Promise<ExtractionResult>; handlerName: string; isDefault: boolean } {
  const hostname = new URL(url).hostname.replace(/^www\./, '');

  // Direct match
  const direct = handlers.get(hostname);
  if (direct) {
    return { handler: direct.handler, handlerName: direct.name, isDefault: false };
  }

  // Check parent domain (e.g., blog.medium.com → medium.com)
  const parts = hostname.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    const parentMatch = handlers.get(parent);
    if (parentMatch) {
      return { handler: parentMatch.handler, handlerName: parentMatch.name, isDefault: false };
    }
  }

  // PDF check (by URL extension, not domain)
  if (/\.pdf(\?|$)/i.test(url)) {
    return { handler: wrapLegacyHandler(extractPdf), handlerName: 'pdf', isDefault: false };
  }

  // Unhandled domain — track it so we know what to build next
  trackDomainHit(hostname);

  return { handler: wrapLegacyHandler(extractDefault), handlerName: 'default', isDefault: true };
}

/**
 * Record a hit for an unhandled domain.
 * Query with: SELECT domain, hit_count FROM domain_hits ORDER BY hit_count DESC
 */
function trackDomainHit(domain: string): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO domain_hits (domain, hit_count, last_seen_at)
      VALUES (?, 1, datetime('now'))
      ON CONFLICT(domain) DO UPDATE SET
        hit_count = hit_count + 1,
        last_seen_at = datetime('now')
    `).run(domain);
  } catch {
    // Don't let tracking failures break extraction
  }
}

/**
 * Main entry point: extract content from a URL.
 * Routes to the appropriate service handler, falls back to default.
 * Returns a typed ExtractionResult with status information.
 */
export async function extractContent(url: string, sourceMetadata?: Record<string, unknown>): Promise<ExtractionResult> {
  const { handler, handlerName, isDefault } = getHandler(url);
  const domain = new URL(url).hostname.replace(/^www\./, '');

  if (isDefault) {
    logger.info({ url, domain }, 'No dedicated handler, using default extractor');
  }

  const result = await handler(url, sourceMetadata);

  // Tag the result with handler name
  result.handlerName = handlerName;

  // Log the extraction attempt
  logExtraction({
    timestamp: new Date().toISOString(),
    url, domain, handler: handlerName,
    textLength: result.content?.text.length ?? 0,
    issues: [],
    bypassUsed: null, bypassSuccess: false,
    finalMethod: result.status === 'success' ? 'direct' : `status:${result.status}`,
    error: result.statusDetail,
  });

  // If a dedicated handler fails with an error, try the default as fallback
  if (!isDefault && result.status === 'error') {
    logger.warn({ url, detail: result.statusDetail }, 'Service handler failed, falling back to default extractor');

    const fallbackResult = await wrapLegacyHandler(extractDefault)(url, sourceMetadata);
    if (fallbackResult.status === 'success') {
      fallbackResult.handlerName = 'default';
      logExtraction({
        timestamp: new Date().toISOString(),
        url, domain, handler: 'default',
        textLength: fallbackResult.content?.text.length ?? 0,
        issues: [],
        bypassUsed: null, bypassSuccess: false,
        finalMethod: 'fallback-default',
      });
      return fallbackResult;
    }
  }

  return result;
}

/** Register a new handler at runtime (legacy signature) */
export function registerHandler(domains: string[], handler: LegacyHandler, name: string): void {
  register(domains, handler, name);
}

export { closeBrowser };
