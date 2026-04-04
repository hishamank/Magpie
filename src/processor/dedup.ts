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

  // Check simhash similarity against recent bookmarks
  const db = getDb();
  const recentBookmarks = db.prepare(`
    SELECT id, content_hash FROM bookmarks
    WHERE content_hash IS NOT NULL AND status = 'completed'
    ORDER BY id DESC LIMIT 500
  `).all() as { id: number; content_hash: string }[];

  for (const row of recentBookmarks) {
    const similarity = simhashSimilarity(contentHash, row.content_hash);
    if (similarity >= 0.9) {
      logger.debug({ contentHash, matchId: row.id, similarity }, 'Similar content found via simhash');
      const bookmark = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(row.id) as BookmarkRow;
      return { isDuplicate: true, existingBookmark: bookmark, reason: `Similar content (${(similarity * 100).toFixed(0)}% match)` };
    }
  }

  return { isDuplicate: false };
}
