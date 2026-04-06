import type { Handler, ExtractedContent } from './types.js';
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

// Domain → handler mapping
const handlers = new Map<string, { handler: Handler; name: string }>();

function register(domains: string[], handler: Handler, name: string): void {
  for (const d of domains) handlers.set(d, { handler, name });
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
function getHandler(url: string): { handler: Handler; handlerName: string; isDefault: boolean } {
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
    return { handler: extractPdf, handlerName: 'pdf', isDefault: false };
  }

  // Unhandled domain — track it so we know what to build next
  trackDomainHit(hostname);

  return { handler: extractDefault, handlerName: 'default', isDefault: true };
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
 */
export async function extractContent(url: string, sourceMetadata?: Record<string, unknown>): Promise<ExtractedContent> {
  const { handler, handlerName, isDefault } = getHandler(url);
  const domain = new URL(url).hostname.replace(/^www\./, '');

  if (isDefault) {
    logger.info({ url, domain }, 'No dedicated handler, using default extractor');
  }

  try {
    const result = await handler(url, sourceMetadata);

    // Default handler does its own logging (with bypass/issue tracking)
    if (!isDefault) {
      logExtraction({
        timestamp: new Date().toISOString(),
        url, domain, handler: handlerName,
        textLength: result.text.length,
        issues: [],
        bypassUsed: null, bypassSuccess: false,
        finalMethod: 'direct',
      });
    }

    return result;
  } catch (err) {
    // If a dedicated handler fails, try the default as fallback
    if (!isDefault) {
      logger.warn({ url, err }, 'Service handler failed, falling back to default extractor');

      logExtraction({
        timestamp: new Date().toISOString(),
        url, domain, handler: handlerName,
        textLength: 0,
        issues: [],
        bypassUsed: null, bypassSuccess: false,
        finalMethod: 'handler-failed',
        error: (err as Error).message,
      });

      return extractDefault(url, sourceMetadata);
    }
    throw err;
  }
}

/** Register a new handler at runtime */
export function registerHandler(domains: string[], handler: Handler, name: string): void {
  register(domains, handler, name);
}

export { closeBrowser };
