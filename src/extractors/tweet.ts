import type { Extractor, ExtractedContent } from './types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('extractor:tweet');

export class TweetExtractor implements Extractor {
  async extract(url: string, sourceMetadata?: Record<string, unknown>): Promise<ExtractedContent> {
    logger.info({ url }, 'Extracting tweet');

    // If we already have tweet data from the collector, use it
    if (sourceMetadata?.tweetText) {
      return {
        title: `Tweet by @${sourceMetadata.authorHandle || 'unknown'}`,
        text: sourceMetadata.tweetText as string,
        author: sourceMetadata.authorHandle as string | undefined,
        publishedAt: sourceMetadata.timestamp as string | undefined,
        images: sourceMetadata.mediaUrls as string[] | undefined,
        links: sourceMetadata.sharedUrl ? [sourceMetadata.sharedUrl as string] : undefined,
        metadata: sourceMetadata,
      };
    }

    // Try to fetch via syndication API (public, no auth needed)
    const tweetId = url.match(/status\/(\d+)/)?.[1];
    if (!tweetId) {
      throw new Error(`Could not extract tweet ID from URL: ${url}`);
    }

    try {
      const resp = await fetch(
        `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
          },
          signal: AbortSignal.timeout(15_000),
        }
      );

      if (resp.ok) {
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
    } catch {
      logger.warn({ tweetId }, 'Syndication API failed');
    }

    // Minimal fallback
    return {
      title: `Tweet ${tweetId}`,
      text: `Tweet from ${url}. Content could not be extracted — try viewing directly.`,
      metadata: { tweetId },
    };
  }
}
