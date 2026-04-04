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
      content_hash TEXT,
      title TEXT,
      source TEXT NOT NULL,
      source_id TEXT,
      media_type TEXT,
      category TEXT,
      subcategories TEXT,
      summary TEXT,
      actionability TEXT,
      quality_signal TEXT,
      raw_content_path TEXT,
      extracted_text TEXT,
      author TEXT,
      source_metadata TEXT,
      collected_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT,
      obsidian_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    CREATE INDEX IF NOT EXISTS idx_bookmarks_category ON bookmarks(category);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_status ON bookmarks(status);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_collected_at ON bookmarks(collected_at);
    CREATE INDEX IF NOT EXISTS idx_keywords_keyword ON keywords(keyword);
    CREATE INDEX IF NOT EXISTS idx_processing_queue_next ON processing_queue(next_attempt_at);
  `);

  logger.info('Database schema initialized');
}
