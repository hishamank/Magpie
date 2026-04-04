import {
  upsertKeyword,
  linkBookmarkKeyword,
  updateKeywordLink,
  upsertBookmarkRelation,
} from '../db/queries.js';
import { getDb } from '../db/connection.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('keywords');

export async function processKeywords(bookmarkId: number, keywords: string[]): Promise<number[]> {
  const keywordIds: number[] = [];

  for (const kw of keywords) {
    const normalized = kw.toLowerCase().trim();
    if (!normalized) continue;
    const id = upsertKeyword(normalized);
    linkBookmarkKeyword(bookmarkId, id);
    keywordIds.push(id);
  }

  logger.debug({ bookmarkId, count: keywordIds.length }, 'Keywords processed');
  return keywordIds;
}

export async function updateKeywordLinks(keywordIds: number[]): Promise<void> {
  for (let i = 0; i < keywordIds.length; i++) {
    for (let j = i + 1; j < keywordIds.length; j++) {
      updateKeywordLink(keywordIds[i], keywordIds[j]);
    }
  }
}

export async function computeRelatedBookmarks(bookmarkId: number, keywordIds: number[]): Promise<void> {
  if (keywordIds.length === 0) return;

  const db = getDb();

  const placeholders = keywordIds.map(() => '?').join(',');
  const related = db.prepare(`
    SELECT bk.bookmark_id, COUNT(*) as shared_count,
           GROUP_CONCAT(k.keyword) as keywords
    FROM bookmark_keywords bk
    JOIN keywords k ON k.id = bk.keyword_id
    WHERE bk.keyword_id IN (${placeholders})
      AND bk.bookmark_id != ?
    GROUP BY bk.bookmark_id
    HAVING shared_count >= 2
    ORDER BY shared_count DESC
    LIMIT 10
  `).all(...keywordIds, bookmarkId) as { bookmark_id: number; shared_count: number; keywords: string }[];

  for (const rel of related) {
    const sharedKeywords = rel.keywords.split(',');
    const score = rel.shared_count / Math.max(keywordIds.length, 1);
    upsertBookmarkRelation(bookmarkId, rel.bookmark_id, sharedKeywords, score);
  }

  logger.debug({ bookmarkId, relatedCount: related.length }, 'Related bookmarks computed');
}
