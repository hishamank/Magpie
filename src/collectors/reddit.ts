import { config } from '../config.js';
import type { BookmarkInput } from './types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('collector:reddit');

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'https://oauth.reddit.com';
const USER_AGENT = 'bookmark-kb:v1.0.0 (by bookmark-kb)';

interface RedditAccount {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

interface RedditToken {
  access_token: string;
  expires_at: number;
}

const tokenCache = new Map<string, RedditToken>();

async function getAccessToken(account: RedditAccount): Promise<string> {
  const cached = tokenCache.get(account.username);
  if (cached && cached.expires_at > Date.now() + 60_000) {
    return cached.access_token;
  }

  const credentials = Buffer.from(`${account.clientId}:${account.clientSecret}`).toString('base64');

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: 'password',
      username: account.username,
      password: account.password,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    throw new Error(`Reddit auth failed for u/${account.username}: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json() as Record<string, unknown>;
  if (data.error) {
    throw new Error(`Reddit auth error for u/${account.username}: ${data.error}`);
  }

  const token: RedditToken = {
    access_token: data.access_token as string,
    expires_at: Date.now() + (data.expires_in as number) * 1000,
  };
  tokenCache.set(account.username, token);
  return token.access_token;
}

async function collectSavedForAccount(
  account: RedditAccount,
  options?: { limit?: number },
): Promise<BookmarkInput[]> {
  const token = await getAccessToken(account);
  const bookmarks: BookmarkInput[] = [];
  const limit = options?.limit ?? Infinity;
  let after: string | null = null;

  logger.info({ username: account.username }, 'Collecting Reddit saved items');

  while (bookmarks.length < limit) {
    const params = new URLSearchParams({ limit: '100', raw_json: '1' });
    if (after) params.set('after', after);

    const resp = await fetch(`${API_BASE}/user/${account.username}/saved?${params}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      throw new Error(`Reddit API error for u/${account.username}: ${resp.status} ${await resp.text()}`);
    }

    const listing = await resp.json() as {
      data: {
        children: Array<{ kind: string; data: Record<string, unknown> }>;
        after: string | null;
      };
    };

    const items = listing.data.children;
    if (items.length === 0) break;

    for (const item of items) {
      if (bookmarks.length >= limit) break;

      const d = item.data;
      const isComment = item.kind === 't1';

      // For comments, link to the comment permalink; for posts, use the URL
      const url = isComment
        ? `https://www.reddit.com${d.permalink as string}`
        : (d.url as string) || `https://www.reddit.com${d.permalink as string}`;

      const title = isComment
        ? `Comment in r/${d.subreddit}: ${(d.body as string || '').slice(0, 100)}`
        : (d.title as string) || '';

      bookmarks.push({
        url,
        title,
        source: 'reddit',
        sourceId: d.name as string, // fullname like t3_abc123
        mediaType: isComment ? 'other' : categorizeRedditPost(d),
        sourceMetadata: {
          subreddit: d.subreddit,
          author: d.author,
          score: d.score,
          numComments: d.num_comments,
          isComment,
          selftext: isComment ? undefined : (d.selftext as string || '').slice(0, 500),
          commentBody: isComment ? (d.body as string || '').slice(0, 500) : undefined,
          permalink: `https://www.reddit.com${d.permalink}`,
          createdUtc: d.created_utc,
          redditAccount: account.username,
        },
        collectedAt: new Date(),
      });
    }

    after = listing.data.after;
    if (!after) break;

    // Rate limiting: Reddit allows 60 requests/min
    await new Promise(r => setTimeout(r, 1000));
  }

  logger.info({ username: account.username, count: bookmarks.length }, 'Reddit saved items collected');
  return bookmarks;
}

function categorizeRedditPost(data: Record<string, unknown>): BookmarkInput['mediaType'] {
  const url = data.url as string || '';
  const isSelf = data.is_self as boolean;

  if (isSelf) return 'article';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'video';
  if (url.includes('github.com')) return 'repo';
  if (url.endsWith('.pdf')) return 'pdf';
  return 'article';
}

export async function collectRedditSaved(options?: { limit?: number }): Promise<BookmarkInput[]> {
  const accounts = config.reddit.accounts;
  if (accounts.length === 0) {
    logger.warn('No Reddit accounts configured, skipping Reddit collection');
    return [];
  }

  const allBookmarks: BookmarkInput[] = [];

  for (const account of accounts) {
    try {
      const bookmarks = await collectSavedForAccount(account, options);
      allBookmarks.push(...bookmarks);
    } catch (err) {
      logger.error({ username: account.username, err }, 'Reddit collection failed for account');
    }
  }

  logger.info({ total: allBookmarks.length, accounts: accounts.length }, 'Reddit collection complete');
  return allBookmarks;
}
