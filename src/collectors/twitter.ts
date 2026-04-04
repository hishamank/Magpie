import { config } from '../config.js';
import type { BookmarkInput } from './types.js';
import { getLogger } from '../utils/logger.js';
import fs from 'node:fs';

const logger = getLogger('collector:twitter');

interface RawCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expirationDate?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

const SAME_SITE_MAP: Record<string, 'Strict' | 'Lax' | 'None'> = {
  strict: 'Strict',
  lax: 'Lax',
  no_restriction: 'None',
  none: 'None',
};

function convertCookies(raw: RawCookie[]) {
  // Filter to only X/Twitter cookies
  const xCookies = raw.filter(c =>
    c.domain.includes('twitter.com') || c.domain.includes('x.com')
  );

  return xCookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    ...(c.expirationDate ? { expires: Math.floor(c.expirationDate) } : {}),
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? true,
    sameSite: SAME_SITE_MAP[c.sameSite || ''] || 'None' as const,
  }));
}

export async function collectTwitterBookmarks(options?: { limit?: number }): Promise<BookmarkInput[]> {
  if (!fs.existsSync(config.twitter.cookiesPath)) {
    logger.warn({ path: config.twitter.cookiesPath }, 'Twitter cookies file not found, skipping');
    return [];
  }

  const limit = options?.limit ?? 100;
  logger.info({ limit }, 'Collecting Twitter bookmarks');

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    // Load and convert cookies (handles browser extension export format)
    const cookieData = JSON.parse(fs.readFileSync(config.twitter.cookiesPath, 'utf-8'));
    const cookies = convertCookies(Array.isArray(cookieData) ? cookieData : []);
    logger.info({ count: cookies.length }, 'Loaded X cookies');

    await context.addCookies(cookies);

    const page = await context.newPage();
    await page.goto('https://x.com/i/bookmarks', { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Wait for tweets to load
    await page.waitForSelector('[data-testid="tweet"]', { timeout: 15_000 });

    const bookmarks: BookmarkInput[] = [];
    const seenIds = new Set<string>();

    // Scroll and collect tweets
    let scrollAttempts = 0;
    const maxScrolls = Math.ceil(limit / 5); // ~5 tweets per scroll

    while (bookmarks.length < limit && scrollAttempts < maxScrolls) {
      const tweets = await page.$$('[data-testid="tweet"]');

      for (const tweet of tweets) {
        if (bookmarks.length >= limit) break;

        try {
          const tweetData = await tweet.evaluate((el) => {
            const linkEl = el.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null;
            const textEl = el.querySelector('[data-testid="tweetText"]');
            const authorEl = el.querySelector('[data-testid="User-Name"] a') as HTMLAnchorElement | null;
            const timeEl = el.querySelector('time');

            const href = linkEl?.href || '';
            const tweetId = href.match(/\/status\/(\d+)/)?.[1] || '';

            // Find shared URLs in the tweet
            const links = Array.from(el.querySelectorAll('a[href^="https://t.co"]')) as HTMLAnchorElement[];
            const sharedUrls = links
              .map(a => a.getAttribute('title') || a.textContent || '')
              .filter(u => u.startsWith('http') && !u.includes('twitter.com') && !u.includes('x.com'));

            return {
              tweetId,
              url: href,
              text: textEl?.textContent || '',
              authorHandle: authorEl?.href?.split('/').pop() || '',
              timestamp: timeEl?.getAttribute('datetime') || '',
              sharedUrl: sharedUrls[0] || null,
            };
          });

          if (!tweetData.tweetId || seenIds.has(tweetData.tweetId)) continue;
          seenIds.add(tweetData.tweetId);

          const tweetUrl = tweetData.url.startsWith('http')
            ? tweetData.url
            : `https://x.com/i/status/${tweetData.tweetId}`;

          bookmarks.push({
            url: tweetData.sharedUrl || tweetUrl,
            title: tweetData.text.slice(0, 100),
            source: 'twitter',
            sourceId: tweetData.tweetId,
            mediaType: tweetData.sharedUrl ? 'article' : 'tweet',
            sourceMetadata: {
              tweetUrl,
              tweetText: tweetData.text,
              authorHandle: tweetData.authorHandle,
              timestamp: tweetData.timestamp,
              sharedUrl: tweetData.sharedUrl,
            },
            collectedAt: tweetData.timestamp ? new Date(tweetData.timestamp) : new Date(),
          });
        } catch (err) {
          logger.debug({ err }, 'Failed to extract tweet data');
        }
      }

      // Scroll down
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(2000 + Math.random() * 3000);
      scrollAttempts++;
    }

    await context.close();
    logger.info({ count: bookmarks.length }, 'Twitter bookmarks collected');
    return bookmarks;
  } finally {
    await browser.close();
  }
}
