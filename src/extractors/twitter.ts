import type { ExtractedContent, MediaAttachment } from './types.js';
import { htmlToMarkdown, extractImageUrls } from './formatter.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('extractor:twitter');

const USER_AGENT = 'bookmark-kb/1.0';
const FX_BASE = 'https://api.fxtwitter.com/2';

interface FxPhoto {
  type: 'photo';
  url: string;
  width: number;
  height: number;
}

interface FxVideo {
  type: 'video' | 'gif';
  url: string;
  thumbnail_url: string;
  width: number;
  height: number;
  duration?: number;
}

interface FxFacet {
  type: 'url' | 'media' | 'mention' | 'hashtag';
  original: string;
  replacement?: string;
  display?: string;
}

interface FxTweet {
  id: string;
  url: string;
  text: string;
  raw_text?: {
    text: string;
    facets?: FxFacet[];
  };
  author: {
    screen_name: string;
    name: string;
    avatar_url?: string;
    description?: string;
  };
  created_at: string;
  created_timestamp: number;
  media?: {
    photos?: FxPhoto[];
    videos?: FxVideo[];
    all?: (FxPhoto | FxVideo)[];
  };
  replying_to?: {
    screen_name: string;
    status: string;
  } | null;
  replies: number;
  reposts: number;
  likes: number;
  bookmarks: number;
  views: number;
  is_note_tweet: boolean;
  lang: string;
  card?: {
    url: string;
    title?: string;
    description?: string;
  };
}

interface FxThreadResponse {
  status: FxTweet;
  thread?: FxTweet[];
}

interface FxStatusResponse {
  status: FxTweet;
}

/**
 * Extract a tweet or thread via FxTwitter API.
 * Falls back to syndication API for single tweets if FxTwitter is down.
 */
export async function extractTwitter(url: string, sourceMetadata?: Record<string, unknown>): Promise<ExtractedContent> {
  // Check if this is an X Article (long-form blog post)
  const articleId = url.match(/\/i\/article\/(\d+)/)?.[1];
  if (articleId) {
    return extractXArticle(url, articleId, sourceMetadata);
  }

  logger.info({ url }, 'Extracting tweet/thread');

  const tweetId = url.match(/status\/(\d+)/)?.[1];
  if (!tweetId) {
    throw new Error(`Could not extract tweet ID from URL: ${url}`);
  }

  // Try FxTwitter thread endpoint first (returns thread + focal tweet)
  try {
    const result = await extractViaFxTwitter(tweetId);
    if (result) return result;
  } catch (err) {
    logger.warn({ tweetId, err }, 'FxTwitter extraction failed');
  }

  // Fallback: syndication API (single tweet only, no thread)
  try {
    const result = await extractViaSyndication(tweetId);
    if (result) return result;
  } catch {
    logger.warn({ tweetId }, 'Syndication API failed');
  }

  // Last resort: use collector metadata if available
  const collectorText = sourceMetadata?.tweetText as string | undefined;
  const authorFromCollector = sourceMetadata?.authorHandle as string | undefined;
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
    text: `Tweet from https://x.com/i/status/${tweetId}. Content could not be extracted.`,
    metadata: { tweetId },
  };
}

/**
 * Extract via FxTwitter API — handles both threads and single tweets.
 */
async function extractViaFxTwitter(tweetId: string): Promise<ExtractedContent | null> {
  // Try thread endpoint first
  const threadResp = await fetch(`${FX_BASE}/thread/${tweetId}`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });

  if (!threadResp.ok) {
    // Fall back to single status endpoint
    const statusResp = await fetch(`${FX_BASE}/status/${tweetId}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!statusResp.ok) return null;

    const statusData = await statusResp.json() as FxStatusResponse;
    return buildContent([statusData.status]);
  }

  const data = await threadResp.json() as FxThreadResponse;
  const tweets = data.thread && data.thread.length > 0
    ? data.thread
    : [data.status];

  return buildContent(tweets);
}

/**
 * Build ExtractedContent from an array of FxTweet objects.
 */
function buildContent(tweets: FxTweet[]): ExtractedContent {
  const author = tweets[0].author;
  const isThread = tweets.length > 1;

  // Collect all media and links across the thread
  const allImages: string[] = [];
  const allLinks: string[] = [];

  // Build text with full content for each tweet
  const parts: string[] = [];

  for (let i = 0; i < tweets.length; i++) {
    const tweet = tweets[i];
    const prefix = isThread ? `**${i + 1}/${tweets.length}**\n` : '';

    // Use the resolved text (URLs already expanded from t.co)
    let tweetText = tweet.text;

    // Collect photos
    const photos = tweet.media?.photos || [];
    for (const photo of photos) {
      allImages.push(photo.url);
    }

    // Collect videos (store thumbnail + note the video)
    const videos = tweet.media?.videos || [];
    for (const video of videos) {
      if (video.thumbnail_url) allImages.push(video.thumbnail_url);
      allLinks.push(video.url);
    }

    // Collect external URLs from facets
    const facets = tweet.raw_text?.facets || [];
    for (const facet of facets) {
      if (facet.type === 'url' && facet.replacement) {
        allLinks.push(facet.replacement);
      }
    }

    // Collect card URL if present
    if (tweet.card?.url) {
      allLinks.push(tweet.card.url);
    }

    // Add image references inline
    const photoLines = photos.map(p => `![](${p.url})`).join('\n');
    const videoLines = videos.map(v => `[Video](${v.url})`).join('\n');
    const mediaBlock = [photoLines, videoLines].filter(Boolean).join('\n');

    const block = [prefix + tweetText, mediaBlock].filter(Boolean).join('\n\n');
    parts.push(block);
  }

  const text = parts.join('\n\n---\n\n');

  // Deduplicate links
  const uniqueLinks = [...new Set(allLinks)].filter(l =>
    !l.includes('x.com/') && !l.includes('twitter.com/')
  );

  const title = isThread
    ? `Thread by @${author.screen_name} (${tweets.length} tweets)`
    : `Tweet by @${author.screen_name}`;

  // Build markdown with metadata header
  const totalLikes = tweets.reduce((s, t) => s + t.likes, 0);
  const totalReposts = tweets.reduce((s, t) => s + t.reposts, 0);
  const totalViews = tweets.reduce((s, t) => s + t.views, 0);
  const metaHeader = [
    `**Author:** @${author.screen_name} (${author.name})`,
    `**Likes:** ${totalLikes} | **Reposts:** ${totalReposts} | **Views:** ${totalViews}`,
    tweets[0].created_at ? `**Date:** ${tweets[0].created_at}` : '',
  ].filter(Boolean).join('\n');

  const markdown = metaHeader + '\n\n---\n\n' + text;

  // Build media attachments
  const media: MediaAttachment[] = [];
  for (const img of allImages) {
    media.push({ type: 'image', sourceUrl: img });
  }
  for (const tweet of tweets) {
    for (const video of (tweet.media?.videos || [])) {
      media.push({ type: 'video', sourceUrl: video.url });
    }
  }

  return {
    title,
    text,
    markdown,
    author: author.screen_name,
    publishedAt: tweets[0].created_at || undefined,
    images: allImages.length > 0 ? allImages : undefined,
    links: uniqueLinks.length > 0 ? uniqueLinks : undefined,
    media: media.length > 0 ? media : undefined,
    metadata: {
      tweetId: tweets[0].id,
      isThread,
      threadLength: tweets.length,
      tweetIds: tweets.map(t => t.id),
      authorName: author.name,
      authorAvatar: author.avatar_url,
      engagement: {
        replies: tweets.reduce((s, t) => s + t.replies, 0),
        reposts: totalReposts,
        likes: totalLikes,
        bookmarks: tweets.reduce((s, t) => s + t.bookmarks, 0),
        views: totalViews,
      },
    },
  };
}

/**
 * Extract an X Article (long-form blog post) via Playwright.
 * These are rendered at x.com/i/article/{id} and require JavaScript.
 */
async function extractXArticle(url: string, articleId: string, sourceMetadata?: Record<string, unknown>): Promise<ExtractedContent> {
  logger.info({ url, articleId }, 'Extracting X Article');

  const articleMeta = sourceMetadata?.article as Record<string, unknown> | undefined;
  const authorHandle = sourceMetadata?.authorHandle as string || '';
  const tweetText = sourceMetadata?.tweetText as string || '';

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    // Load cookies for authenticated access
    const fs = await import('node:fs');
    const { config } = await import('../config.js');
    if (fs.existsSync(config.twitter.cookiesPath)) {
      const cookieData = JSON.parse(fs.readFileSync(config.twitter.cookiesPath, 'utf-8'));
      const cookies = (Array.isArray(cookieData) ? cookieData : [])
        .filter((c: Record<string, unknown>) =>
          (c.domain as string)?.includes('twitter.com') || (c.domain as string)?.includes('x.com')
        )
        .map((c: Record<string, unknown>) => ({
          name: c.name as string,
          value: c.value as string,
          domain: c.domain as string,
          path: (c.path as string) || '/',
          httpOnly: (c.httpOnly as boolean) ?? false,
          secure: (c.secure as boolean) ?? true,
          sameSite: 'None' as const,
        }));
      await context.addCookies(cookies);
    }

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Wait for article content to render
    await page.waitForSelector('article, [data-testid="tweetText"], [role="article"]', { timeout: 15_000 }).catch(() => {});
    // Extra wait for JS rendering
    await page.waitForTimeout(3000);

    // Extract the article content
    const articleContent = await page.evaluate(() => {
      // X articles render in a specific container
      // Try multiple selectors that X uses for article content
      const selectors = [
        'article[data-testid="tweet"]',
        '[data-testid="article"]',
        'article',
        '[role="article"]',
        'main',
      ];

      let container: Element | null = null;
      for (const sel of selectors) {
        container = document.querySelector(sel);
        if (container && container.textContent && container.textContent.length > 100) break;
      }

      if (!container) {
        // Fallback: get the whole body
        container = document.body;
      }

      return {
        html: container.innerHTML,
        text: container.textContent?.trim() || '',
        title: document.title || '',
      };
    });

    await context.close();

    const title = articleMeta?.title as string || articleContent.title || `X Article by @${authorHandle}`;
    const markdown = htmlToMarkdown(articleContent.html, url);
    const images = extractImageUrls(articleContent.html, url)
      .filter(img => !img.includes('emoji') && !img.includes('profile_images'));

    // Build rich markdown with metadata
    const header = [
      `# ${title}`,
      '',
      `**Author:** @${authorHandle}`,
      articleMeta?.previewText ? `**Preview:** ${articleMeta.previewText}` : '',
      tweetText ? `**Tweet:** ${tweetText}` : '',
      '',
      '---',
      '',
    ].filter(Boolean).join('\n');

    const media: MediaAttachment[] = images.map(img => ({
      type: 'image' as const,
      sourceUrl: img,
    }));

    return {
      title,
      text: articleContent.text,
      markdown: header + markdown,
      author: authorHandle,
      images: images.length > 0 ? images : undefined,
      media: media.length > 0 ? media : undefined,
      metadata: {
        articleId,
        isXArticle: true,
        authorHandle,
        tweetText,
      },
    };
  } finally {
    await browser.close();
  }
}

/**
 * Fallback: syndication API for a single tweet.
 */
async function extractViaSyndication(tweetId: string): Promise<ExtractedContent | null> {
  const resp = await fetch(
    `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en`,
    {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15_000),
    }
  );

  if (!resp.ok) return null;

  const data = await resp.json() as Record<string, unknown>;
  const text = (data.text as string) || '';
  const user = data.user as Record<string, unknown> | undefined;

  const mediaDetails = data.mediaDetails as Array<Record<string, unknown>> | undefined;
  const images = mediaDetails
    ?.filter(m => m.type === 'photo')
    .map(m => (m.media_url_https as string) + '?name=orig') || [];

  return {
    title: `Tweet by @${user?.screen_name || 'unknown'}`,
    text,
    author: user?.screen_name as string | undefined,
    publishedAt: data.created_at as string | undefined,
    images: images.length > 0 ? images : undefined,
    metadata: { tweetId },
  };
}
