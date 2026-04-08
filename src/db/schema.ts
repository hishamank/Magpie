import { getDb } from './connection.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('schema');

export function initSchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL UNIQUE,
      title TEXT,
      source TEXT NOT NULL,
      source_id TEXT,
      media_type TEXT,
      source_metadata TEXT,
      collected_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS processed_bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bookmark_id INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      extraction_status TEXT,
      content_hash TEXT,
      raw_content_path TEXT,
      extracted_text TEXT,
      title TEXT,
      author TEXT,
      category TEXT,
      content_type TEXT,
      type_metadata TEXT,
      subcategories TEXT,
      summary TEXT,
      actionability TEXT,
      quality_signal TEXT,
      thumbnail TEXT,
      obsidian_path TEXT,
      error_message TEXT,
      processed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL UNIQUE,
      usage_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bookmark_keywords (
      bookmark_id INTEGER NOT NULL,
      keyword_id INTEGER NOT NULL,
      relevance REAL DEFAULT 1.0,
      PRIMARY KEY (bookmark_id, keyword_id),
      FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE,
      FOREIGN KEY (keyword_id) REFERENCES keywords(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS keyword_links (
      keyword_a_id INTEGER NOT NULL,
      keyword_b_id INTEGER NOT NULL,
      strength INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (keyword_a_id, keyword_b_id),
      FOREIGN KEY (keyword_a_id) REFERENCES keywords(id) ON DELETE CASCADE,
      FOREIGN KEY (keyword_b_id) REFERENCES keywords(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bookmark_relations (
      bookmark_a_id INTEGER NOT NULL,
      bookmark_b_id INTEGER NOT NULL,
      shared_keywords TEXT,
      relation_score REAL,
      PRIMARY KEY (bookmark_a_id, bookmark_b_id),
      FOREIGN KEY (bookmark_a_id) REFERENCES bookmarks(id) ON DELETE CASCADE,
      FOREIGN KEY (bookmark_b_id) REFERENCES bookmarks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS processing_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bookmark_id INTEGER NOT NULL UNIQUE,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS collector_state (
      source TEXT PRIMARY KEY,
      last_collected_at TEXT NOT NULL,
      last_source_id TEXT,
      items_collected INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS domain_hits (
      domain TEXT PRIMARY KEY,
      hit_count INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_bookmarks_url_hash ON bookmarks(url_hash);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_source ON bookmarks(source);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_collected_at ON bookmarks(collected_at);
    CREATE INDEX IF NOT EXISTS idx_processed_bookmark_id ON processed_bookmarks(bookmark_id);
    CREATE INDEX IF NOT EXISTS idx_processed_status ON processed_bookmarks(status);
    CREATE INDEX IF NOT EXISTS idx_processed_category ON processed_bookmarks(category);
    CREATE INDEX IF NOT EXISTS idx_processed_content_type ON processed_bookmarks(content_type);
    CREATE INDEX IF NOT EXISTS idx_keywords_keyword ON keywords(keyword);
    CREATE INDEX IF NOT EXISTS idx_processing_queue_next ON processing_queue(next_attempt_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bookmark_id INTEGER NOT NULL,
      attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL,
      handler TEXT,
      method TEXT,
      text_length INTEGER DEFAULT 0,
      duration_ms INTEGER,
      error_message TEXT,
      FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_extraction_attempts_bookmark ON extraction_attempts(bookmark_id);

    CREATE TABLE IF NOT EXISTS media_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bookmark_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      source_url TEXT NOT NULL,
      local_path TEXT,
      mime_type TEXT,
      alt_text TEXT,
      ocr_text TEXT,
      transcription TEXT,
      file_size INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_media_bookmark ON media_attachments(bookmark_id);
  `);

  // Migration: if old-style bookmarks table has processing columns, migrate to new schema.
  // This handles the transition from single-table to two-table design.
  const cols = db.prepare("PRAGMA table_info(bookmarks)").all() as { name: string }[];
  const colNames = new Set(cols.map(c => c.name));
  if (colNames.has('status') && colNames.has('extracted_text')) {
    // Old schema detected — migrate any processed data to processed_bookmarks
    const hasProcessed = db.prepare(
      "SELECT COUNT(*) as count FROM bookmarks WHERE status NOT IN ('pending') AND extracted_text IS NOT NULL"
    ).get() as { count: number };
    if (hasProcessed.count > 0) {
      db.exec(`
        INSERT OR IGNORE INTO processed_bookmarks (
          bookmark_id, status, extraction_status, content_hash, raw_content_path,
          extracted_text, title, author, category, content_type, type_metadata,
          subcategories, summary, actionability, quality_signal, thumbnail,
          obsidian_path, error_message, processed_at
        )
        SELECT
          id, status, extraction_status, content_hash, raw_content_path,
          extracted_text, title, author, category, content_type, type_metadata,
          subcategories, summary, actionability, quality_signal, thumbnail,
          obsidian_path, error_message, processed_at
        FROM bookmarks
        WHERE status NOT IN ('pending') AND extracted_text IS NOT NULL
      `);
      logger.info({ count: hasProcessed.count }, 'Migrated processed bookmarks to new table');
    }
  }

  logger.info('Database schema initialized');
}
