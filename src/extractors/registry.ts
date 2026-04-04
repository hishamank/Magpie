import type { Handler, ExtractedContent } from './types.js';
import { extractDefault, closeBrowser } from './default.js';
import { extractYouTube } from './youtube.js';
import { extractTwitter } from './twitter.js';
import { extractMedium } from './medium.js';
import { extractGitHub } from './github.js';
import { extractPdf } from './pdf.js';
import { getDb } from '../db/connection.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('extractor:registry');

// Domain → handler mapping
const handlers = new Map<string, Handler>();

function register(domains: string[], handler: Handler): void {
  for (const d of domains) handlers.set(d, handler);
}

// Register all service handlers
register(['youtube.com', 'youtu.be'], extractYouTube);
register(['twitter.com', 'x.com'], extractTwitter);
register(['github.com'], extractGitHub);
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
], extractMedium);

/**
 * Resolve a URL to its handler by matching the domain.
 * Falls back to default handler and tracks unhandled domains.
 */
function getHandler(url: string): { handler: Handler; isDefault: boolean } {
  const hostname = new URL(url).hostname.replace(/^www\./, '');

  // Direct match
  if (handlers.has(hostname)) {
    return { handler: handlers.get(hostname)!, isDefault: false };
  }

  // Check parent domain (e.g., blog.medium.com → medium.com)
  const parts = hostname.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    if (handlers.has(parent)) {
      return { handler: handlers.get(parent)!, isDefault: false };
    }
  }

  // PDF check (by URL extension, not domain)
  if (/\.pdf(\?|$)/i.test(url)) {
    return { handler: extractPdf, isDefault: false };
  }

  // Unhandled domain — track it so we know what to build next
  trackDomainHit(hostname);

  return { handler: extractDefault, isDefault: true };
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
  const { handler, isDefault } = getHandler(url);

  if (isDefault) {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    logger.info({ url, domain: hostname }, 'No dedicated handler, using default extractor');
  }

  try {
    return await handler(url, sourceMetadata);
  } catch (err) {
    // If a dedicated handler fails, try the default as fallback
    if (!isDefault) {
      logger.warn({ url, err }, 'Service handler failed, falling back to default extractor');
      return extractDefault(url, sourceMetadata);
    }
    throw err;
  }
}

/** Register a new handler at runtime (used by service modules) */
export function registerHandler(domains: string[], handler: Handler): void {
  register(domains, handler);
}

export { closeBrowser };
