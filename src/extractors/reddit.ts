import type { ExtractedContent, MediaAttachment } from './types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('extractor:reddit');
const USER_AGENT = 'bookmark-kb:v1.0.0 (by bookmark-kb)';

/**
 * Extract content from Reddit URLs using the public JSON API.
 * Avoids scraping Reddit's JS-heavy SPA.
 */
export async function extractReddit(url: string, sourceMetadata?: Record<string, unknown>): Promise<ExtractedContent> {
  // If collector already gave us the content, use it directly
  if (sourceMetadata?.selftext || sourceMetadata?.commentBody) {
    return extractFromMetadata(url, sourceMetadata);
  }

  // Otherwise fetch via Reddit's JSON API (works without auth)
  return extractFromJsonApi(url);
}

function extractFromMetadata(url: string, meta: Record<string, unknown>): ExtractedContent {
  const isComment = meta.isComment as boolean;

  const title = isComment
    ? `Comment by u/${meta.author} in r/${meta.subreddit}`
    : `${meta.subreddit ? `r/${meta.subreddit}: ` : ''}${meta.title || ''}`;

  const parts: string[] = [];
  if (meta.selftext) parts.push(meta.selftext as string);
  if (meta.commentBody) parts.push(meta.commentBody as string);

  const text = parts.join('\n\n') || '';

  return {
    title,
    text,
    markdown: text, // Reddit content is already markdown
    author: meta.author as string | undefined,
    metadata: {
      subreddit: meta.subreddit,
      score: meta.score,
      numComments: meta.numComments,
      permalink: meta.permalink,
    },
  };
}

async function extractFromJsonApi(url: string): Promise<ExtractedContent> {
  // Normalize URL and append .json
  const cleanUrl = url.replace(/\/?(\?.*)?$/, '');
  const jsonUrl = `${cleanUrl}.json`;

  logger.debug({ jsonUrl }, 'Fetching Reddit JSON');

  const resp = await fetch(jsonUrl, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    throw new Error(`Reddit JSON API error: ${resp.status}`);
  }

  const data = await resp.json() as unknown;

  // Reddit returns an array: [post_listing, comments_listing]
  // For a single post URL, data[0].data.children[0] is the post
  if (Array.isArray(data) && data.length > 0) {
    return extractPost(data);
  }

  // User saved page or listing — data.data.children is an array
  if (typeof data === 'object' && data !== null && 'data' in (data as Record<string, unknown>)) {
    const listing = (data as { data: { children: Array<{ kind: string; data: Record<string, unknown> }> } });
    if (listing.data.children.length > 0) {
      const first = listing.data.children[0].data;
      return {
        title: (first.title as string) || '',
        text: (first.selftext as string) || (first.body as string) || '',
        author: first.author as string | undefined,
      };
    }
  }

  throw new Error('Could not parse Reddit JSON response');
}

function extractPost(data: Array<{ data: { children: Array<{ kind: string; data: Record<string, unknown> }> } }>): ExtractedContent {
  const postData = data[0].data.children[0].data;
  const title = (postData.title as string) || '';
  const selftext = (postData.selftext as string) || '';
  const author = postData.author as string;
  const subreddit = postData.subreddit as string;
  const score = postData.score as number;

  // Collect top comments for context
  const commentParts: string[] = [];
  if (data[1]?.data?.children) {
    for (const child of data[1].data.children.slice(0, 10)) {
      if (child.kind !== 't1') continue;
      const body = child.data.body as string;
      const cAuthor = child.data.author as string;
      const cScore = child.data.score as number;
      if (body && cAuthor) {
        commentParts.push(`**u/${cAuthor}** (${cScore} points):\n${body}`);
      }
    }
  }

  const parts = [selftext];
  if (commentParts.length > 0) {
    parts.push('---\n## Top Comments\n');
    parts.push(commentParts.join('\n\n'));
  }

  const text = parts.filter(Boolean).join('\n\n');

  // Discover media from post (gallery images, hosted videos)
  const media: MediaAttachment[] = [];
  const postUrl = postData.url as string || '';
  const isSelf = postData.is_self as boolean;
  if (!isSelf && /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(postUrl)) {
    media.push({ type: 'image', sourceUrl: postUrl });
  }
  if (!isSelf && /v\.redd\.it/i.test(postUrl)) {
    media.push({ type: 'video', sourceUrl: postUrl });
  }

  return {
    title: `r/${subreddit}: ${title}`,
    text,
    markdown: text, // Reddit content is already markdown
    author,
    media: media.length > 0 ? media : undefined,
    metadata: {
      subreddit,
      score,
      numComments: postData.num_comments,
      isLinkPost: !isSelf,
      externalUrl: isSelf ? undefined : postData.url,
    },
  };
}
