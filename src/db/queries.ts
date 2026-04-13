import { getDb } from './connection.js';

// --- Types ---

/** Collection-only data (bookmarks table — append-only, never wiped) */
export interface CollectedBookmarkRow {
  id: number;
  url: string;
  url_hash: string;
  title: string | null;
  source: string;
  source_id: string | null;
  media_type: string | null;
  source_metadata: string | null;
  collected_at: string;
  created_at: string;
  updated_at: string;
}

/** Processing output (processed_bookmarks table — safe to wipe and rebuild) */
export interface ProcessedBookmarkRow {
  id: number;
  bookmark_id: number;
  status: string;
  extraction_status: string | null;
  content_hash: string | null;
  raw_content_path: string | null;
  extracted_text: string | null;
  title: string | null;
  author: string | null;
  category: string | null;
  content_type: string | null;
  type_metadata: string | null;
  subcategories: string | null;
  summary: string | null;
  actionability: string | null;
  quality_signal: string | null;
  thumbnail: string | null;
  obsidian_path: string | null;
  error_message: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Joined view of bookmarks + processed_bookmarks.
 * This is what most consumer code works with — same shape as the old BookmarkRow.
 */
export interface BookmarkRow {
  // From bookmarks table
  id: number;
  url: string;
  url_hash: string;
  source: string;
  source_id: string | null;
  media_type: string | null;
  source_metadata: string | null;
  collected_at: string;
  created_at: string;
  updated_at: string;
  // Merged title: LLM title (from processing) takes precedence over collected title
  title: string | null;
  // From processed_bookmarks (null if not yet processed)
  status: string;
  extraction_status: string | null;
  content_hash: string | null;
  raw_content_path: string | null;
  extracted_text: string | null;
  author: string | null;
  category: string | null;
  content_type: string | null;
  type_metadata: string | null;
  subcategories: string | null;
  summary: string | null;
  actionability: string | null;
  quality_signal: string | null;
  thumbnail: string | null;
  obsidian_path: string | null;
  error_message: string | null;
  processed_at: string | null;
}

/** Standard SELECT for joined bookmark queries */
const FULL_SELECT = `
  SELECT
    b.id, b.url, b.url_hash, b.source, b.source_id, b.media_type,
    b.source_metadata, b.collected_at, b.created_at, b.updated_at,
    COALESCE(pb.title, b.title) as title,
    COALESCE(pb.status, 'pending') as status,
    pb.extraction_status, pb.content_hash, pb.raw_content_path,
    pb.extracted_text, pb.author, pb.category, pb.content_type,
    pb.type_metadata, pb.subcategories, pb.summary, pb.actionability,
    pb.quality_signal, pb.thumbnail, pb.obsidian_path,
    pb.error_message, pb.processed_at
  FROM bookmarks b
  LEFT JOIN processed_bookmarks pb ON b.id = pb.bookmark_id
`;

// --- Collection queries (bookmarks table) ---

export interface InsertBookmarkParams {
  url: string;
  urlHash: string;
  title?: string;
  source: string;
  sourceId?: string;
  mediaType?: string;
  sourceMetadata?: Record<string, unknown>;
  collectedAt?: Date;
}

export function getBookmarkByUrlHash(urlHash: string): BookmarkRow | undefined {
  const db = getDb();
  return db.prepare(`${FULL_SELECT} WHERE b.url_hash = ?`).get(urlHash) as BookmarkRow | undefined;
}

export function insertBookmark(params: InsertBookmarkParams): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO bookmarks (url, url_hash, title, source, source_id, media_type, source_metadata, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.url,
    params.urlHash,
    params.title ?? null,
    params.source,
    params.sourceId ?? null,
    params.mediaType ?? null,
    params.sourceMetadata ? JSON.stringify(params.sourceMetadata) : null,
    params.collectedAt?.toISOString() ?? new Date().toISOString(),
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

// --- Processing queries (processed_bookmarks table) ---

export interface UpsertProcessedParams {
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
  thumbnail?: string;
  contentType?: string;
  typeMetadata?: string;
  extractionStatus?: string;
  obsidianPath?: string;
  processedAt?: string;
  status?: string;
  errorMessage?: string;
}

/**
 * Insert or update processing results for a bookmark.
 * This writes to processed_bookmarks (safe to wipe and rebuild).
 */
export function upsertProcessedBookmark(bookmarkId: number, params: UpsertProcessedParams): void {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM processed_bookmarks WHERE bookmark_id = ?').get(bookmarkId);

  if (existing) {
    db.prepare(`
      UPDATE processed_bookmarks SET
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
        thumbnail = COALESCE(?, thumbnail),
        content_type = COALESCE(?, content_type),
        type_metadata = COALESCE(?, type_metadata),
        extraction_status = COALESCE(?, extraction_status),
        obsidian_path = COALESCE(?, obsidian_path),
        processed_at = COALESCE(?, processed_at),
        status = COALESCE(?, status),
        error_message = COALESCE(?, error_message),
        updated_at = datetime('now')
      WHERE bookmark_id = ?
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
      params.thumbnail ?? null,
      params.contentType ?? null,
      params.typeMetadata ?? null,
      params.extractionStatus ?? null,
      params.obsidianPath ?? null,
      params.processedAt ?? null,
      params.status ?? null,
      params.errorMessage ?? null,
      bookmarkId,
    );
  } else {
    db.prepare(`
      INSERT INTO processed_bookmarks (
        bookmark_id, title, content_hash, raw_content_path, extracted_text,
        author, category, subcategories, summary, actionability, quality_signal,
        thumbnail, content_type, type_metadata, extraction_status, obsidian_path,
        processed_at, status, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bookmarkId,
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
      params.thumbnail ?? null,
      params.contentType ?? null,
      params.typeMetadata ?? null,
      params.extractionStatus ?? null,
      params.obsidianPath ?? null,
      params.processedAt ?? null,
      params.status ?? 'processing',
      params.errorMessage ?? null,
    );
  }
}

/** Update processing status on processed_bookmarks. Creates row if needed. */
export function updateProcessingStatus(bookmarkId: number, status: string, errorMessage?: string): void {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM processed_bookmarks WHERE bookmark_id = ?').get(bookmarkId);
  if (existing) {
    db.prepare(`
      UPDATE processed_bookmarks SET status = ?, error_message = COALESCE(?, error_message), updated_at = datetime('now')
      WHERE bookmark_id = ?
    `).run(status, errorMessage ?? null, bookmarkId);
  } else {
    db.prepare(`
      INSERT INTO processed_bookmarks (bookmark_id, status, error_message)
      VALUES (?, ?, ?)
    `).run(bookmarkId, status, errorMessage ?? null);
  }
}

export function updateObsidianPath(bookmarkId: number, obsidianPath: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE processed_bookmarks SET obsidian_path = ?, updated_at = datetime('now')
    WHERE bookmark_id = ?
  `).run(obsidianPath, bookmarkId);
}

// --- Queue & status queries ---

export function getPendingBookmarks(limit: number = 10): BookmarkRow[] {
  const db = getDb();
  return db.prepare(`
    ${FULL_SELECT}
    JOIN processing_queue q ON b.id = q.bookmark_id
    WHERE COALESCE(pb.status, 'pending') IN ('pending', 'failed')
      AND q.attempts < q.max_attempts
      AND q.next_attempt_at <= datetime('now')
    ORDER BY RANDOM()
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

export function deleteBookmark(bookmarkId: number): void {
  const db = getDb();
  db.prepare('DELETE FROM processing_queue WHERE bookmark_id = ?').run(bookmarkId);
  db.prepare('DELETE FROM processed_bookmarks WHERE bookmark_id = ?').run(bookmarkId);
  db.prepare('DELETE FROM bookmark_keywords WHERE bookmark_id = ?').run(bookmarkId);
  db.prepare('DELETE FROM bookmark_relations WHERE bookmark_a_id = ? OR bookmark_b_id = ?').run(bookmarkId, bookmarkId);
  db.prepare('DELETE FROM bookmarks WHERE id = ?').run(bookmarkId);
}

// --- Read queries (joined view) ---

export function getBookmarkById(id: number): BookmarkRow | undefined {
  const db = getDb();
  return db.prepare(`${FULL_SELECT} WHERE b.id = ?`).get(id) as BookmarkRow | undefined;
}

export function getAllBookmarks(): BookmarkRow[] {
  const db = getDb();
  return db.prepare(`${FULL_SELECT} ORDER BY b.collected_at DESC`).all() as BookmarkRow[];
}

export function getBookmarksByStatus(status: string): BookmarkRow[] {
  const db = getDb();
  return db.prepare(`${FULL_SELECT} WHERE COALESCE(pb.status, 'pending') = ? ORDER BY b.collected_at DESC`).all(status) as BookmarkRow[];
}

export function getBookmarksByCategory(category: string): BookmarkRow[] {
  const db = getDb();
  return db.prepare(`${FULL_SELECT} WHERE pb.category = ? ORDER BY b.collected_at DESC`).all(category) as BookmarkRow[];
}

export function getStats(): {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  skipped: number;
  contentRemoved: number;
  paywall: number;
  bySource: { source: string; count: number }[];
  byCategory: { category: string; count: number }[];
} {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as count FROM bookmarks').get() as { count: number }).count;

  // Processing stats from processed_bookmarks
  const statusCounts = db.prepare(`
    SELECT COALESCE(pb.status, 'pending') as status, COUNT(*) as count
    FROM bookmarks b
    LEFT JOIN processed_bookmarks pb ON b.id = pb.bookmark_id
    GROUP BY COALESCE(pb.status, 'pending')
  `).all() as { status: string; count: number }[];

  const getCount = (s: string) => statusCounts.find(r => r.status === s)?.count || 0;

  const bySource = db.prepare('SELECT source, COUNT(*) as count FROM bookmarks GROUP BY source ORDER BY count DESC').all() as { source: string; count: number }[];
  const byCategory = db.prepare(`
    SELECT pb.category, COUNT(*) as count
    FROM processed_bookmarks pb
    WHERE pb.category IS NOT NULL
    GROUP BY pb.category ORDER BY count DESC
  `).all() as { category: string; count: number }[];

  return {
    total,
    pending: getCount('pending'),
    processing: getCount('processing'),
    completed: getCount('completed'),
    failed: getCount('failed'),
    skipped: statusCounts
      .filter(r => r.status === 'skipped' || r.status.startsWith('skipped_'))
      .reduce((sum, r) => sum + r.count, 0),
    contentRemoved: getCount('content_removed'),
    paywall: getCount('paywall'),
    bySource,
    byCategory,
  };
}

export function searchBookmarks(query: string, limit: number = 20): BookmarkRow[] {
  const db = getDb();
  const pattern = `%${query}%`;
  return db.prepare(`
    ${FULL_SELECT}
    WHERE COALESCE(pb.title, b.title) LIKE ?
      OR pb.extracted_text LIKE ?
      OR pb.summary LIKE ?
    ORDER BY b.collected_at DESC
    LIMIT ?
  `).all(pattern, pattern, pattern, limit) as BookmarkRow[];
}

// --- Extraction status & attempts ---

export function markContentRemoved(bookmarkId: number): void {
  updateProcessingStatus(bookmarkId, 'content_removed');
  upsertProcessedBookmark(bookmarkId, { extractionStatus: 'content_removed' });
  const db = getDb();
  db.prepare('DELETE FROM processing_queue WHERE bookmark_id = ?').run(bookmarkId);
}

/**
 * Mark a bookmark as skipped by the pre-classifier skip gate.
 * `reason` is the skip category (e.g. 'music_video'). The DB status is
 * stored as `'skipped_' + reason` so existing status-breakdown queries
 * can tell the categories apart.
 */
export function markSkipped(
  bookmarkId: number,
  reason: string,
  fields: {
    title?: string;
    author?: string;
    thumbnail?: string;
    obsidianPath?: string;
  },
): void {
  upsertProcessedBookmark(bookmarkId, {
    status: `skipped_${reason}`,
    contentType: reason,
    title: fields.title,
    author: fields.author,
    thumbnail: fields.thumbnail,
    obsidianPath: fields.obsidianPath,
    processedAt: new Date().toISOString(),
  });
  const db = getDb();
  db.prepare('DELETE FROM processing_queue WHERE bookmark_id = ?').run(bookmarkId);
}

export function requeueWithDelay(bookmarkId: number, delaySec: number): void {
  updateProcessingStatus(bookmarkId, 'pending');
  upsertProcessedBookmark(bookmarkId, { extractionStatus: 'rate_limited' });
  const db = getDb();
  db.prepare(`
    UPDATE processing_queue
    SET next_attempt_at = datetime('now', '+' || ? || ' seconds')
    WHERE bookmark_id = ?
  `).run(delaySec, bookmarkId);
}

export function updateExtractionStatus(bookmarkId: number, extractionStatus: string): void {
  upsertProcessedBookmark(bookmarkId, { extractionStatus });
}

export interface InsertExtractionAttemptParams {
  bookmarkId: number;
  status: string;
  handler?: string;
  method?: string;
  textLength?: number;
  durationMs?: number;
  errorMessage?: string;
}

export function insertExtractionAttempt(params: InsertExtractionAttemptParams): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO extraction_attempts (bookmark_id, status, handler, method, text_length, duration_ms, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.bookmarkId,
    params.status,
    params.handler ?? null,
    params.method ?? null,
    params.textLength ?? 0,
    params.durationMs ?? null,
    params.errorMessage ?? null,
  );
}

export function getExtractionAttempts(bookmarkId: number): {
  id: number;
  attempted_at: string;
  status: string;
  handler: string | null;
  method: string | null;
  text_length: number;
  duration_ms: number | null;
  error_message: string | null;
}[] {
  const db = getDb();
  return db.prepare(`
    SELECT id, attempted_at, status, handler, method, text_length, duration_ms, error_message
    FROM extraction_attempts
    WHERE bookmark_id = ?
    ORDER BY attempted_at DESC
  `).all(bookmarkId) as {
    id: number;
    attempted_at: string;
    status: string;
    handler: string | null;
    method: string | null;
    text_length: number;
    duration_ms: number | null;
    error_message: string | null;
  }[];
}

// --- Media attachments ---

export interface MediaAttachmentRow {
  id: number;
  bookmark_id: number;
  type: string;
  source_url: string;
  local_path: string | null;
  mime_type: string | null;
  alt_text: string | null;
  ocr_text: string | null;
  transcription: string | null;
  file_size: number | null;
  created_at: string;
}

export function insertMediaAttachment(bookmarkId: number, attachment: {
  type: string;
  sourceUrl: string;
  localPath?: string;
  mimeType?: string;
  altText?: string;
  fileSize?: number;
}): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO media_attachments (bookmark_id, type, source_url, local_path, mime_type, alt_text, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    bookmarkId,
    attachment.type,
    attachment.sourceUrl,
    attachment.localPath ?? null,
    attachment.mimeType ?? null,
    attachment.altText ?? null,
    attachment.fileSize ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function getMediaAttachments(bookmarkId: number): MediaAttachmentRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM media_attachments WHERE bookmark_id = ? ORDER BY id'
  ).all(bookmarkId) as MediaAttachmentRow[];
}

export function updateMediaAttachment(id: number, updates: {
  localPath?: string;
  mimeType?: string;
  ocrText?: string;
  transcription?: string;
  fileSize?: number;
}): void {
  const db = getDb();
  db.prepare(`
    UPDATE media_attachments SET
      local_path = COALESCE(?, local_path),
      mime_type = COALESCE(?, mime_type),
      ocr_text = COALESCE(?, ocr_text),
      transcription = COALESCE(?, transcription),
      file_size = COALESCE(?, file_size)
    WHERE id = ?
  `).run(
    updates.localPath ?? null,
    updates.mimeType ?? null,
    updates.ocrText ?? null,
    updates.transcription ?? null,
    updates.fileSize ?? null,
    id,
  );
}

// --- Keyword queries ---

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
      CASE WHEN r.bookmark_a_id = ? THEN r.bookmark_b_id ELSE r.bookmark_a_id END as id,
      CASE WHEN r.bookmark_a_id = ?
        THEN COALESCE(pb2.title, b2.title)
        ELSE COALESCE(pb1.title, b1.title)
      END as title,
      CASE WHEN r.bookmark_a_id = ?
        THEN pb2.obsidian_path
        ELSE pb1.obsidian_path
      END as obsidian_path,
      r.shared_keywords,
      r.relation_score
    FROM bookmark_relations r
    JOIN bookmarks b1 ON b1.id = r.bookmark_a_id
    JOIN bookmarks b2 ON b2.id = r.bookmark_b_id
    LEFT JOIN processed_bookmarks pb1 ON pb1.bookmark_id = b1.id
    LEFT JOIN processed_bookmarks pb2 ON pb2.bookmark_id = b2.id
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
  const db = getDb();
  return db.prepare(`
    ${FULL_SELECT}
    WHERE pb.content_hash = ? AND pb.status = 'completed'
    LIMIT 1
  `).get(contentHash) as BookmarkRow | undefined;
}

// --- Collector state ---

export interface CollectorState {
  source: string;
  last_collected_at: string;
  last_source_id: string | null;
  items_collected: number;
}

export function getCollectorState(source: string): CollectorState | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM collector_state WHERE source = ?').get(source) as CollectorState | undefined;
}

export function updateCollectorState(source: string, lastSourceId?: string, itemsCollected?: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO collector_state (source, last_collected_at, last_source_id, items_collected)
    VALUES (?, datetime('now'), ?, ?)
    ON CONFLICT(source) DO UPDATE SET
      last_collected_at = datetime('now'),
      last_source_id = COALESCE(?, last_source_id),
      items_collected = COALESCE(?, 0) + items_collected
  `).run(source, lastSourceId ?? null, itemsCollected ?? 0, lastSourceId ?? null, itemsCollected ?? null);
}

export function getExistingSourceIds(source: string): Set<string> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT source_id FROM bookmarks WHERE source = ? AND source_id IS NOT NULL'
  ).all(source) as { source_id: string }[];
  return new Set(rows.map(r => r.source_id));
}

export function getQueueStats(): { total: number; ready: number; retrying: number } {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as count FROM processing_queue').get() as { count: number }).count;
  const ready = (db.prepare("SELECT COUNT(*) as count FROM processing_queue WHERE next_attempt_at <= datetime('now')").get() as { count: number }).count;
  const retrying = (db.prepare('SELECT COUNT(*) as count FROM processing_queue WHERE attempts > 0').get() as { count: number }).count;
  return { total, ready, retrying };
}

// --- Reset processing (safe — bookmarks table untouched) ---

/**
 * Wipe all processing results and re-queue everything for reprocessing.
 * The bookmarks table (collected URLs) is NEVER touched.
 * Media attachments are preserved (expensive to re-download).
 */
export function resetAllProcessing(): { bookmarksPreserved: number; processedDeleted: number } {
  const db = getDb();

  const totalBookmarks = (db.prepare('SELECT COUNT(*) as c FROM bookmarks').get() as { c: number }).c;
  const processedCount = (db.prepare('SELECT COUNT(*) as c FROM processed_bookmarks').get() as { c: number }).c;

  db.exec(`
    DELETE FROM processed_bookmarks;
    DELETE FROM bookmark_keywords;
    DELETE FROM keywords;
    DELETE FROM keyword_links;
    DELETE FROM bookmark_relations;
    DELETE FROM extraction_attempts;
    DELETE FROM processing_queue;
  `);

  // Re-queue all bookmarks for processing
  db.exec(`
    INSERT INTO processing_queue (bookmark_id)
    SELECT id FROM bookmarks
  `);

  return { bookmarksPreserved: totalBookmarks, processedDeleted: processedCount };
}
