import type { ExtractedContent } from './types.js';
import { config } from '../config.js';
import { getLogger } from '../utils/logger.js';
import fs from 'node:fs';

const logger = getLogger('extractor:twitter');

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

interface TweetData {
  tweetId: string;
  text: string;
  authorHandle: string;
  timestamp: string;
  mediaUrls: string[];
  sharedUrls: string[];
  isReply: boolean;
}

const SAME_SITE_MAP: Record<string, 'Strict' | 'Lax' | 'None'> = {
  strict: 'Strict', lax: 'Lax', no_restriction: 'None', none: 'None',
};

function convertCookies(raw: RawCookie[]) {
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

/**
 * Extract a tweet or thread using Playwright with cookies.
 * Falls back to syndication API if cookies are unavailable.
 */
export async function extractTwitter(url: string, sourceMetadata?: Record<string, unknown>): Promise<ExtractedContent> {
  logger.info({ url }, 'Extracting tweet/thread');

  const tweetId = url.match(/status\/(\d+)/)?.[1];
  if (!tweetId) {
    throw new Error(`Could not extract tweet ID from URL: ${url}`);
  }

  // If we have collector metadata with tweet text but it's short, still try thread extraction
  const collectorText = sourceMetadata?.tweetText as string | undefined;
  const authorFromCollector = sourceMetadata?.authorHandle as string | undefined;

  // Try Playwright thread extraction first (needs cookies)
  const hasCookies = fs.existsSync(config.twitter.cookiesPath);
  if (hasCookies) {
    try {
      return await extractThread(url, tweetId, sourceMetadata);
    } catch (err) {
      logger.warn({ tweetId, err }, 'Playwright thread extraction failed, trying fallback');
    }
  }

  // Fallback: syndication API (single tweet only)
  try {
    const result = await extractViaSyndication(tweetId);
    if (result) return result;
  } catch {
    logger.warn({ tweetId }, 'Syndication API failed');
  }

  // Last resort: use collector data if available
  if (collectorText) {
    return {
      title: `Tweet by @${authorFromCollector || 'unknown'}`,
      text: collectorText,
      author: authorFromCollector,
      publishedAt: sourceMetadata?.timestamp as string | undefined,
      metadata: { tweetId, ...sourceMetadata },
    };
  }

  return {
    title: `Tweet ${tweetId}`,
    text: `Tweet from ${url}. Content could not be extracted.`,
    metadata: { tweetId },
  };
}

/**
 * Use Playwright to load a tweet page and extract the full thread.
 */
async function extractThread(
  url: string,
  tweetId: string,
  sourceMetadata?: Record<string, unknown>,
): Promise<ExtractedContent> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const cookieData = JSON.parse(fs.readFileSync(config.twitter.cookiesPath, 'utf-8'));
    const cookies = convertCookies(Array.isArray(cookieData) ? cookieData : []);
    await context.addCookies(cookies);

    const page = await context.newPage();

    // Navigate to the tweet
    const tweetUrl = url.startsWith('http') ? url : `https://x.com/i/status/${tweetId}`;
    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Wait for the main tweet to load
    await page.waitForSelector('[data-testid="tweet"]', { timeout: 15_000 });

    // Give the thread time to render
    await page.waitForTimeout(2000);

    // Find the tweet author handle from the main tweet
    const mainAuthor = await page.evaluate(() => {
      const mainTweet = document.querySelector('[data-testid="tweet"]');
      if (!mainTweet) return '';
      const authorLink = mainTweet.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null;
      if (!authorLink) return '';
      const href = authorLink.href;
      // URL format: /username/status/id — extract username
      const match = href.match(/\.com\/([^/]+)\/status\//);
      return match?.[1] || '';
    });

    const author = mainAuthor || (sourceMetadata?.authorHandle as string) || '';

    // Scroll to load the full thread if needed
    let lastCount = 0;
    for (let i = 0; i < 5; i++) {
      const currentCount = await page.$$eval('[data-testid="tweet"]', els => els.length);
      if (currentCount === lastCount && i > 0) break;
      lastCount = currentCount;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(1500);
    }

    // Extract all tweets on the page
    const allTweets = await page.$$eval('[data-testid="tweet"]', (tweets) => {
      return tweets.map(tweet => {
        const textEl = tweet.querySelector('[data-testid="tweetText"]');
        const linkEl = tweet.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null;
        const timeEl = tweet.querySelector('time');
        const authorEl = tweet.querySelector('[data-testid="User-Name"] a') as HTMLAnchorElement | null;

        const href = linkEl?.href || '';
        const id = href.match(/\/status\/(\d+)/)?.[1] || '';
        const handle = authorEl?.href?.split('/').pop() || '';

        // Get media
        const images = Array.from(tweet.querySelectorAll('img[src*="pbs.twimg.com/media"]'))
          .map(img => (img as HTMLImageElement).src);

        // Get shared URLs (t.co links with titles)
        const links = Array.from(tweet.querySelectorAll('a[href^="https://t.co"]'))
          .map(a => (a as HTMLAnchorElement).getAttribute('title') || (a as HTMLAnchorElement).textContent || '')
          .filter(u => u.startsWith('http') && !u.includes('twitter.com') && !u.includes('x.com'));

        return {
          tweetId: id,
          text: textEl?.textContent || '',
          authorHandle: handle,
          timestamp: timeEl?.getAttribute('datetime') || '',
          mediaUrls: images,
          sharedUrls: links,
          isReply: false,
        };
      });
    }) as TweetData[];

    await context.close();

    // Filter to thread tweets: same author, appearing before the main tweet or as self-replies
    const threadTweets = allTweets.filter(t =>
      t.authorHandle.toLowerCase() === author.toLowerCase() && t.text.length > 0
    );

    // Deduplicate by tweetId
    const seen = new Set<string>();
    const uniqueTweets = threadTweets.filter(t => {
      if (!t.tweetId || seen.has(t.tweetId)) return false;
      seen.add(t.tweetId);
      return true;
    });

    const isThread = uniqueTweets.length > 1;
    const allMedia = uniqueTweets.flatMap(t => t.mediaUrls);
    const allLinks = uniqueTweets.flatMap(t => t.sharedUrls);
    const timestamp = uniqueTweets[0]?.timestamp || sourceMetadata?.timestamp as string || '';

    // Build the text
    let text: string;
    if (isThread) {
      text = uniqueTweets
        .map((t, i) => `${i + 1}/${uniqueTweets.length} ${t.text}`)
        .join('\n\n');
    } else {
      text = uniqueTweets[0]?.text || '';
    }

    const title = isThread
      ? `Thread by @${author} (${uniqueTweets.length} tweets)`
      : `Tweet by @${author}`;

    return {
      title,
      text,
      author,
      publishedAt: timestamp || undefined,
      images: allMedia.length > 0 ? allMedia : undefined,
      links: allLinks.length > 0 ? allLinks : undefined,
      metadata: {
        ...sourceMetadata,
        tweetId,
        isThread,
        threadLength: uniqueTweets.length,
        tweetIds: uniqueTweets.map(t => t.tweetId),
      },
    };
  } finally {
    await browser.close();
  }
}

async function extractViaSyndication(tweetId: string): Promise<ExtractedContent | null> {
  const resp = await fetch(
    `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(15_000),
    }
  );

  if (!resp.ok) return null;

  const data = await resp.json() as Record<string, unknown>;
  const text = (data.text as string) || '';
  const user = data.user as Record<string, unknown> | undefined;

  return {
    title: `Tweet by @${user?.screen_name || 'unknown'}`,
    text,
    author: user?.screen_name as string | undefined,
    publishedAt: data.created_at as string | undefined,
    metadata: { tweetId, ...data },
  };
}
