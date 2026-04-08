import { config } from '../config.js';
import type { BookmarkInput } from './types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('collector:raindrop');

const RAINDROP_API = 'https://api.raindrop.io/rest/v1';

export async function collectRaindropBookmarks(options?: { limit?: number }): Promise<BookmarkInput[]> {
  if (!config.raindrop.token) {
    logger.warn('RAINDROP_TOKEN not configured, skipping Raindrop collection');
    return [];
  }

  const bookmarks: BookmarkInput[] = [];
  let page = 0;
  const perPage = 50;
  const limit = options?.limit ?? Infinity;

  logger.info('Collecting Raindrop bookmarks');

  while (bookmarks.length < limit) {
    // Collection -1 = all collections (not just unsorted)
    const resp = await fetch(`${RAINDROP_API}/raindrops/-1?page=${page}&perpage=${perPage}&sort=-created`, {
      headers: {
        'Authorization': `Bearer ${config.raindrop.token}`,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      throw new Error(`Raindrop API error: ${resp.status} ${await resp.text()}`);
    }

    const data = await resp.json() as { items: Record<string, unknown>[] };
    if (!data.items || data.items.length === 0) break;

    for (const item of data.items) {
      if (bookmarks.length >= limit) break;

      const tags = item.tags as string[] || [];

      bookmarks.push({
        url: item.link as string,
        title: item.title as string,
        source: 'raindrop',
        sourceId: String(item._id),
        sourceMetadata: {
          excerpt: item.excerpt,
          tags,
          collection: (item.collection as Record<string, unknown>)?.$id,
          type: item.type,
          cover: item.cover,
        },
        collectedAt: item.created ? new Date(item.created as string) : new Date(),
      });
    }

    if (data.items.length < perPage) break;
    page++;

    await new Promise(r => setTimeout(r, 500));
  }

  logger.info({ count: bookmarks.length }, 'Raindrop bookmarks collected');
  return bookmarks;
}
