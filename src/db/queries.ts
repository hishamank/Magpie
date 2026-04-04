import { getDb } from './connection.js';

export interface BookmarkRow {
  id: number;
  url: string;
  url_hash: string;
  content_hash: string | null;
  title: string | null;
  source: string;
  source_id: string | null;
  media_type: string | null;
  category: string | null;
  subcategories: string | null;
  summary: string | null;
  actionability: string | null;
  quality_signal: string | null;
  raw_content_path: string | null;
  extracted_text: string | null;
  author: string | null;
  source_metadata: string | null;
  collected_at: string;
  processed_at: string | null;
  obsidian_path: string | null;
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertBookmarkParams {
  url: string;
  urlHash: string;
  title?: string;
  source: string;
  sourceId?: string;
  mediaType?: string;
  sourceMetadata?: Record<string, unknown>;
  collectedAt?: Date;
  status?: string;
}

export function getBookmarkByUrlHash(urlHash: string): BookmarkRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM bookmarks WHERE url_hash = ?').get(urlHash) as BookmarkRow | undefined;
}

export function insertBookmark(params: InsertBookmarkParams): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO bookmarks (url, url_hash, title, source, source_id, media_type, source_metadata, collected_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.url,
    params.urlHash,
    params.title ?? null,
    params.source,
    params.sourceId ?? null,
    params.mediaType ?? null,
    params.sourceMetadata ? JSON.stringify(params.sourceMetadata) : null,
    params.collectedAt?.toISOString() ?? new Date().toISOString(),
    params.status ?? 'pending',
  );
  return Number(result.lastInsertRowid);
}

export function addToProcessingQueue(bookmarkId: number): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO processing_queue (bookmark_id)
    VALUES (?)
  `).run(bookmarkId);
}

export interface UpdateBookmarkFullParams {
  title?: string;
  contentHash?: string;
  rawContentPath?: string;
  extractedText?: string;
  author?: string;
  category?: string;
  subcategories?: string;
  summary?: string;
  actionability?: string;
  qualitySignal?: string;
  processedAt?: string;
  status?: string;
}

export function updateBookmarkFull(id: number, params: UpdateBookmarkFullParams): void {
  const db = getDb();
  db.prepare(`
    UPDATE bookmarks SET
      title = COALESCE(?, title),
      content_hash = COALESCE(?, content_hash),
      raw_content_path = COALESCE(?, raw_content_path),
      extracted_text = COALESCE(?, extracted_text),
      author = COALESCE(?, author),
      category = COALESCE(?, category),
      subcategories = COALESCE(?, subcategories),
      summary = COALESCE(?, summary),
      actionability = COALESCE(?, actionability),
      quality_signal = COALESCE(?, quality_signal),
      processed_at = COALESCE(?, processed_at),
      status = COALESCE(?, status),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    params.title ?? null,
    params.contentHash ?? null,
    params.rawContentPath ?? null,
    params.extractedText ?? null,
    params.author ?? null,
    params.category ?? null,
    params.subcategories ?? null,
    params.summary ?? null,
    params.actionability ?? null,
    params.qualitySignal ?? null,
    params.processedAt ?? null,
    params.status ?? null,
    id,
  );
}

export function updateBookmarkStatus(id: number, status: string, errorMessage?: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE bookmarks SET status = ?, error_message = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, errorMessage ?? null, id);
}

export function updateObsidianPath(id: number, obsidianPath: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE bookmarks SET obsidian_path = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(obsidianPath, id);
}

export function getPendingBookmarks(limit: number = 10): BookmarkRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT b.* FROM bookmarks b
    JOIN processing_queue q ON b.id = q.bookmark_id
    WHERE b.status IN ('pending', 'failed')
      AND q.attempts < q.max_attempts
      AND q.next_attempt_at <= datetime('now')
    ORDER BY q.next_attempt_at ASC
    LIMIT ?
  `).all(limit) as BookmarkRow[];
}

export function incrementQueueAttempt(bookmarkId: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE processing_queue
    SET attempts = attempts + 1,
        next_attempt_at = datetime('now', '+' || (attempts * 5) || ' minutes')
    WHERE bookmark_id = ?
  `).run(bookmarkId);
}

export function removeFromQueue(bookmarkId: number): void {
  const db = getDb();
  db.prepare('DELETE FROM processing_queue WHERE bookmark_id = ?').run(bookmarkId);
}

export function getBookmarkById(id: number): BookmarkRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id) as BookmarkRow | undefined;
}

export function getAllBookmarks(): BookmarkRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM bookmarks ORDER BY collected_at DESC').all() as BookmarkRow[];
}

export function getBookmarksByStatus(status: string): BookmarkRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM bookmarks WHERE status = ? ORDER BY collected_at DESC').all(status) as BookmarkRow[];
}

export function getBookmarksByCategory(category: string): BookmarkRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM bookmarks WHERE category = ? ORDER BY collected_at DESC').all(category) as BookmarkRow[];
}

export function getStats(): {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  skipped: number;
  bySource: { source: string; count: number }[];
  byCategory: { category: string; count: number }[];
} {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as count FROM bookmarks').get() as { count: number }).count;
  const pending = (db.prepare("SELECT COUNT(*) as count FROM bookmarks WHERE status = 'pending'").get() as { count: number }).count;
  const processing = (db.prepare("SELECT COUNT(*) as count FROM bookmarks WHERE status = 'processing'").get() as { count: number }).count;
  const completed = (db.prepare("SELECT COUNT(*) as count FROM bookmarks WHERE status = 'completed'").get() as { count: number }).count;
  const failed = (db.prepare("SELECT COUNT(*) as count FROM bookmarks WHERE status = 'failed'").get() as { count: number }).count;
  const skipped = (db.prepare("SELECT COUNT(*) as count FROM bookmarks WHERE status = 'skipped'").get() as { count: number }).count;
  const bySource = db.prepare('SELECT source, COUNT(*) as count FROM bookmarks GROUP BY source ORDER BY count DESC').all() as { source: string; count: number }[];
  const byCategory = db.prepare("SELECT category, COUNT(*) as count FROM bookmarks WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC").all() as { category: string; count: number }[];

  return { total, pending, processing, completed, failed, skipped, bySource, byCategory };
}

export function searchBookmarks(query: string, limit: number = 20): BookmarkRow[] {
  const db = getDb();
  const pattern = `%${query}%`;
  return db.prepare(`
    SELECT * FROM bookmarks
    WHERE title LIKE ? OR extracted_text LIKE ? OR summary LIKE ?
    ORDER BY collected_at DESC
    LIMIT ?
  `).all(pattern, pattern, pattern, limit) as BookmarkRow[];
}

// Keyword queries
export function upsertKeyword(keyword: string): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO keywords (keyword) VALUES (?)
    ON CONFLICT(keyword) DO UPDATE SET usage_count = usage_count + 1
  `).run(keyword);
  const row = db.prepare('SELECT id FROM keywords WHERE keyword = ?').get(keyword) as { id: number };
  return row.id;
}

export function linkBookmarkKeyword(bookmarkId: number, keywordId: number, relevance: number = 1.0): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO bookmark_keywords (bookmark_id, keyword_id, relevance)
    VALUES (?, ?, ?)
  `).run(bookmarkId, keywordId, relevance);
}

export function getBookmarkKeywords(bookmarkId: number): { keyword: string; relevance: number }[] {
  const db = getDb();
  return db.prepare(`
    SELECT k.keyword, bk.relevance
    FROM bookmark_keywords bk
    JOIN keywords k ON k.id = bk.keyword_id
    WHERE bk.bookmark_id = ?
    ORDER BY bk.relevance DESC
  `).all(bookmarkId) as { keyword: string; relevance: number }[];
}

export function getAllKeywordsWithCounts(): { keyword: string; usage_count: number }[] {
  const db = getDb();
  return db.prepare('SELECT keyword, usage_count FROM keywords ORDER BY usage_count DESC').all() as { keyword: string; usage_count: number }[];
}

export function updateKeywordLink(keywordAId: number, keywordBId: number): void {
  const db = getDb();
  // Ensure consistent ordering
  const [a, b] = keywordAId < keywordBId ? [keywordAId, keywordBId] : [keywordBId, keywordAId];
  db.prepare(`
    INSERT INTO keyword_links (keyword_a_id, keyword_b_id, strength)
    VALUES (?, ?, 1)
    ON CONFLICT(keyword_a_id, keyword_b_id) DO UPDATE SET strength = strength + 1
  `).run(a, b);
}

export function upsertBookmarkRelation(
  bookmarkAId: number,
  bookmarkBId: number,
  sharedKeywords: string[],
  score: number
): void {
  const db = getDb();
  const [a, b] = bookmarkAId < bookmarkBId ? [bookmarkAId, bookmarkBId] : [bookmarkBId, bookmarkAId];
  db.prepare(`
    INSERT INTO bookmark_relations (bookmark_a_id, bookmark_b_id, shared_keywords, relation_score)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(bookmark_a_id, bookmark_b_id) DO UPDATE SET
      shared_keywords = ?,
      relation_score = ?
  `).run(a, b, JSON.stringify(sharedKeywords), score, JSON.stringify(sharedKeywords), score);
}

export function getRelatedBookmarks(bookmarkId: number, limit: number = 5): {
  id: number;
  title: string;
  obsidian_path: string | null;
  shared_keywords: string;
  relation_score: number;
}[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      CASE WHEN r.bookmark_a_id = ? THEN b2.id ELSE b1.id END as id,
      CASE WHEN r.bookmark_a_id = ? THEN b2.title ELSE b1.title END as title,
      CASE WHEN r.bookmark_a_id = ? THEN b2.obsidian_path ELSE b1.obsidian_path END as obsidian_path,
      r.shared_keywords,
      r.relation_score
    FROM bookmark_relations r
    JOIN bookmarks b1 ON b1.id = r.bookmark_a_id
    JOIN bookmarks b2 ON b2.id = r.bookmark_b_id
    WHERE r.bookmark_a_id = ? OR r.bookmark_b_id = ?
    ORDER BY r.relation_score DESC
    LIMIT ?
  `).all(bookmarkId, bookmarkId, bookmarkId, bookmarkId, bookmarkId, limit) as {
    id: number;
    title: string;
    obsidian_path: string | null;
    shared_keywords: string;
    relation_score: number;
  }[];
}

export function findSimilarContent(contentHash: string, _threshold: number): BookmarkRow | undefined {
  // For exact content hash match — simhash comparison done in application layer
  const db = getDb();
  return db.prepare(`
    SELECT * FROM bookmarks WHERE content_hash = ? AND status = 'completed' LIMIT 1
  `).get(contentHash) as BookmarkRow | undefined;
}

export function getQueueStats(): { total: number; ready: number; retrying: number } {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as count FROM processing_queue').get() as { count: number }).count;
  const ready = (db.prepare("SELECT COUNT(*) as count FROM processing_queue WHERE next_attempt_at <= datetime('now')").get() as { count: number }).count;
  const retrying = (db.prepare('SELECT COUNT(*) as count FROM processing_queue WHERE attempts > 0').get() as { count: number }).count;
  return { total, ready, retrying };
}
