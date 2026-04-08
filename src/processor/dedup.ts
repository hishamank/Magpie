import { normalizeUrl } from '../utils/url.js';
import { hashUrl, computeSimhash, simhashSimilarity } from '../utils/hash.js';
import { getBookmarkByUrlHash, findSimilarContent } from '../db/queries.js';
import { getDb } from '../db/connection.js';
import type { BookmarkRow } from '../db/queries.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('dedup');

export { normalizeUrl, hashUrl };

export interface DedupResult {
  isDuplicate: boolean;
  existingBookmark?: BookmarkRow;
  reason?: string;
}

export function checkUrlDuplicate(url: string): DedupResult {
  const normalized = normalizeUrl(url);
  const urlHash = hashUrl(normalized);
  const existing = getBookmarkByUrlHash(urlHash);

  if (existing) {
    logger.debug({ url }, 'URL duplicate found');
    return { isDuplicate: true, existingBookmark: existing, reason: 'URL already exists' };
  }

  return { isDuplicate: false };
}

export function checkContentDuplicate(contentHash: string): DedupResult {
  const existing = findSimilarContent(contentHash, 0.9);

  if (existing) {
    logger.debug({ contentHash }, 'Content duplicate found (exact hash match)');
    return { isDuplicate: true, existingBookmark: existing, reason: 'Identical content hash' };
  }

  // Check simhash similarity against recent processed bookmarks
  const db = getDb();
  const recentBookmarks = db.prepare(`
    SELECT pb.bookmark_id as id, pb.content_hash FROM processed_bookmarks pb
    WHERE pb.content_hash IS NOT NULL AND pb.status = 'completed'
    ORDER BY pb.bookmark_id DESC LIMIT 500
  `).all() as { id: number; content_hash: string }[];

  for (const row of recentBookmarks) {
    const similarity = simhashSimilarity(contentHash, row.content_hash);
    if (similarity >= 0.9) {
      logger.debug({ contentHash, matchId: row.id, similarity }, 'Similar content found via simhash');
      return { isDuplicate: true, reason: `Similar content (${(similarity * 100).toFixed(0)}% match)` };
    }
  }

  return { isDuplicate: false };
}
