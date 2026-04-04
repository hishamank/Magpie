import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getBookmarkById, getBookmarkKeywords, getRelatedBookmarks } from '../db/queries.js';
import { buildNoteContent, buildNoteName, getCategoryFolder } from './templates.js';
import type { EnrichmentResult } from '../processor/enricher.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('obsidian:compiler');

export async function compileObsidianNote(bookmarkId: number, enrichment?: EnrichmentResult | null): Promise<string> {
  const bookmark = getBookmarkById(bookmarkId);
  if (!bookmark) {
    throw new Error(`Bookmark not found: ${bookmarkId}`);
  }

  const keywords = getBookmarkKeywords(bookmarkId);
  const related = getRelatedBookmarks(bookmarkId);

  const content = buildNoteContent({ bookmark, keywords, related, enrichment: enrichment ?? undefined });

  // Determine file path
  const folder = getCategoryFolder(bookmark.category);
  const noteName = buildNoteName(bookmark);
  const relativePath = path.join(folder, `${noteName}.md`);
  const fullPath = path.join(config.vault.path, relativePath);

  // Ensure directory exists
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });

  // Write the note
  fs.writeFileSync(fullPath, content, 'utf-8');

  logger.info({ bookmarkId, path: relativePath }, 'Obsidian note compiled');
  return relativePath;
}
