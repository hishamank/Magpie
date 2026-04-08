import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import {
  getAllBookmarks,
  getStats,
  getBookmarksByCategory,
  getAllKeywordsWithCounts,
} from '../db/queries.js';
import { getDb } from '../db/connection.js';
import { buildNoteName, getCategoryFolder } from './templates.js';
import type { BookmarkRow } from '../db/queries.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('obsidian:indexer');

export function updateAllIndexFiles(): void {
  generateMainIndex();
  generateCategoryIndex();
  generateTagIndex();
  generateRecentIndex();
  generateToReadIndex();
  generateMachineIndex();
  logger.info('All index files updated');
}

function writeIndex(filename: string, content: string): void {
  const filePath = path.join(config.vault.path, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function noteLink(bookmark: BookmarkRow): string {
  const name = buildNoteName(bookmark);
  return `[[${name}|${bookmark.title || 'Untitled'}]]`;
}

function generateMainIndex(): void {
  const stats = getStats();
  const lines: string[] = [
    '# Bookmark Knowledge Base',
    '',
    `> Last updated: ${new Date().toISOString().slice(0, 10)}`,
    '',
    '## Stats',
    '',
    `- **Total bookmarks:** ${stats.total}`,
    `- **Completed:** ${stats.completed}`,
    `- **Pending:** ${stats.pending}`,
    `- **Failed:** ${stats.failed}`,
    '',
  ];

  if (stats.bySource.length > 0) {
    lines.push('## By Source');
    lines.push('');
    for (const { source, count } of stats.bySource) {
      lines.push(`- **${source}:** ${count}`);
    }
    lines.push('');
  }

  if (stats.byCategory.length > 0) {
    lines.push('## By Category');
    lines.push('');
    for (const { category, count } of stats.byCategory) {
      lines.push(`- [[_index_by_category#${category}|${category}]]: ${count}`);
    }
    lines.push('');
  }

  lines.push('## Quick Links');
  lines.push('');
  lines.push('- [[_index_by_category]] — Browse by category');
  lines.push('- [[_index_by_tag]] — Browse by tag');
  lines.push('- [[_recent]] — Recently added');
  lines.push('- [[_to_read]] — Reading list');
  lines.push('');

  writeIndex('_index.md', lines.join('\n'));
}

function generateCategoryIndex(): void {
  const stats = getStats();
  const lines: string[] = [
    '# Bookmarks by Category',
    '',
  ];

  for (const { category } of stats.byCategory) {
    const bookmarks = getBookmarksByCategory(category);
    lines.push(`## ${category}`);
    lines.push('');
    for (const b of bookmarks) {
      const date = (b.collected_at || b.created_at).slice(0, 10);
      lines.push(`- ${date} — ${noteLink(b)}`);
    }
    lines.push('');
  }

  writeIndex('_index_by_category.md', lines.join('\n'));
}

function generateTagIndex(): void {
  const keywords = getAllKeywordsWithCounts();
  const db = getDb();
  const lines: string[] = [
    '# Bookmarks by Tag',
    '',
  ];

  for (const { keyword, usage_count } of keywords.slice(0, 100)) {
    const bookmarks = db.prepare(`
      SELECT b.id, b.url, b.url_hash, b.source, b.source_id, b.media_type,
        b.source_metadata, b.collected_at, b.created_at, b.updated_at,
        COALESCE(pb.title, b.title) as title,
        COALESCE(pb.status, 'pending') as status,
        pb.category, pb.obsidian_path, pb.summary
      FROM bookmarks b
      LEFT JOIN processed_bookmarks pb ON b.id = pb.bookmark_id
      JOIN bookmark_keywords bk ON b.id = bk.bookmark_id
      JOIN keywords k ON k.id = bk.keyword_id
      WHERE k.keyword = ? AND COALESCE(pb.status, 'pending') = 'completed'
      ORDER BY b.collected_at DESC
    `).all(keyword) as BookmarkRow[];

    if (bookmarks.length > 0) {
      lines.push(`## ${keyword} (${usage_count})`);
      lines.push('');
      for (const b of bookmarks) {
        lines.push(`- ${noteLink(b)}`);
      }
      lines.push('');
    }
  }

  writeIndex('_index_by_tag.md', lines.join('\n'));
}

function generateRecentIndex(): void {
  const db = getDb();
  const recent = db.prepare(`
    SELECT b.id, b.url, b.url_hash, b.source, b.source_id, b.media_type,
      b.source_metadata, b.collected_at, b.created_at, b.updated_at,
      COALESCE(pb.title, b.title) as title,
      pb.category, pb.obsidian_path, pb.summary, pb.actionability, pb.quality_signal
    FROM bookmarks b
    JOIN processed_bookmarks pb ON b.id = pb.bookmark_id
    WHERE pb.status = 'completed'
    ORDER BY b.collected_at DESC
    LIMIT 50
  `).all() as BookmarkRow[];

  const lines: string[] = [
    '# Recent Bookmarks',
    '',
  ];

  for (const b of recent) {
    const date = (b.collected_at || b.created_at).slice(0, 10);
    lines.push(`- ${date} — ${noteLink(b)} (${b.category || 'other'}, ${b.source})`);
  }
  lines.push('');

  writeIndex('_recent.md', lines.join('\n'));
}

function generateToReadIndex(): void {
  const db = getDb();
  const toRead = db.prepare(`
    SELECT b.id, b.url, b.url_hash, b.source, b.source_id, b.media_type,
      b.source_metadata, b.collected_at, b.created_at, b.updated_at,
      COALESCE(pb.title, b.title) as title,
      pb.category, pb.obsidian_path, pb.summary, pb.actionability, pb.quality_signal
    FROM bookmarks b
    JOIN processed_bookmarks pb ON b.id = pb.bookmark_id
    WHERE pb.status = 'completed'
      AND pb.actionability IN ('to-read', 'to-watch')
    ORDER BY
      CASE pb.quality_signal
        WHEN 'comprehensive' THEN 1
        WHEN 'deep-dive' THEN 2
        WHEN 'standard' THEN 3
        WHEN 'quick-tip' THEN 4
        ELSE 5
      END,
      b.collected_at DESC
  `).all() as BookmarkRow[];

  const lines: string[] = [
    '# Reading & Watch List',
    '',
    `> ${toRead.length} items`,
    '',
  ];

  let currentQuality = '';
  for (const b of toRead) {
    const quality = b.quality_signal || 'standard';
    if (quality !== currentQuality) {
      currentQuality = quality;
      lines.push(`## ${quality}`);
      lines.push('');
    }
    const action = b.actionability === 'to-watch' ? '[watch]' : '[read]';
    lines.push(`- ${action} ${noteLink(b)}`);
  }
  lines.push('');

  writeIndex('_to_read.md', lines.join('\n'));
}

/**
 * Machine-readable index: one JSON entry per completed bookmark.
 * Designed for LLM context — compact enough to scan thousands of entries,
 * detailed enough to decide which notes to read in full.
 */
function generateMachineIndex(): void {
  const db = getDb();
  const bookmarks = db.prepare(`
    SELECT b.id, b.url, COALESCE(pb.title, b.title) as title, b.source,
           pb.category, pb.summary, pb.actionability, pb.quality_signal,
           pb.author, b.collected_at, pb.obsidian_path
    FROM bookmarks b
    JOIN processed_bookmarks pb ON b.id = pb.bookmark_id
    WHERE pb.status = 'completed'
    ORDER BY b.collected_at DESC
  `).all() as BookmarkRow[];

  const entries = bookmarks.map(b => {
    // Get keywords for this bookmark
    const keywords = db.prepare(`
      SELECT k.keyword FROM keywords k
      JOIN bookmark_keywords bk ON k.id = bk.keyword_id
      WHERE bk.bookmark_id = ?
    `).all(b.id) as { keyword: string }[];

    const noteName = buildNoteName(b);
    const folder = getCategoryFolder(b.category);

    return {
      id: b.id,
      slug: noteName,
      path: `${folder}/${noteName}`,
      title: b.title || 'Untitled',
      url: b.url,
      source: b.source,
      category: b.category || 'other',
      tags: keywords.map(k => k.keyword),
      summary: b.summary || '',
      quality: b.quality_signal || 'standard',
      actionability: b.actionability || 'reference',
      author: b.author || undefined,
      date: (b.collected_at || '').slice(0, 10),
    };
  });

  const index = {
    generated: new Date().toISOString(),
    count: entries.length,
    entries,
  };

  const filePath = path.join(config.vault.path, '_index.json');
  fs.writeFileSync(filePath, JSON.stringify(index, null, 2), 'utf-8');
}
