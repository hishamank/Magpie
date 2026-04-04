import { extractContent } from '../extractors/registry.js';
import { classifyContent } from './classifier.js';
import { archiveContent } from './archiver.js';
import { processKeywords, updateKeywordLinks, computeRelatedBookmarks } from './keywords.js';
import { compileObsidianNote } from '../obsidian/compiler.js';
import { updateAllIndexFiles } from '../obsidian/indexer.js';
import { computeSimhash } from '../utils/hash.js';
import {
  getBookmarkByUrlHash,
  insertBookmark,
  updateBookmarkFull,
  updateBookmarkStatus,
  updateObsidianPath,
  incrementQueueAttempt,
  removeFromQueue,
  addToProcessingQueue,
} from '../db/queries.js';
import { normalizeUrl, hashUrl } from '../processor/dedup.js';
import type { BookmarkInput } from '../collectors/types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('processor');

/**
 * Process a bookmark that already exists in the DB (called from the `process` command).
 * The bookmarkId parameter is the existing row ID.
 */
export async function processBookmark(input: BookmarkInput, bookmarkId: number): Promise<void> {
  logger.info({ url: input.url, bookmarkId }, 'Processing bookmark');

  incrementQueueAttempt(bookmarkId);
  updateBookmarkStatus(bookmarkId, 'processing');

  try {
    // Step 1: Extract content
    const content = await extractContent(input.url, input.sourceMetadata);

    // Step 2: Content-based dedup check
    const contentHash = computeSimhash(content.text);

    // Step 3: Archive raw content
    const rawPath = await archiveContent(bookmarkId, input.source, content);

    // Step 4: Classify with LLM
    const classification = await classifyContent(content, input);

    // Step 5: Process keywords and linking
    const keywordIds = await processKeywords(bookmarkId, classification.keywords);
    await updateKeywordLinks(keywordIds);
    await computeRelatedBookmarks(bookmarkId, keywordIds);

    // Step 6: Update database
    updateBookmarkFull(bookmarkId, {
      title: content.title || input.title,
      contentHash,
      rawContentPath: rawPath,
      extractedText: content.text,
      author: content.author,
      category: classification.category,
      subcategories: JSON.stringify(classification.subcategories),
      summary: classification.summary,
      actionability: classification.actionability,
      qualitySignal: classification.qualitySignal,
      processedAt: new Date().toISOString(),
      status: 'completed',
    });

    // Step 7: Compile Obsidian note
    const obsidianPath = await compileObsidianNote(bookmarkId);
    updateObsidianPath(bookmarkId, obsidianPath);

    // Step 8: Update index files
    updateAllIndexFiles();

    // Remove from queue on success
    removeFromQueue(bookmarkId);

    logger.info({ url: input.url, category: classification.category }, 'Bookmark processed successfully');
  } catch (err) {
    logger.error({ url: input.url, err }, 'Failed to process bookmark');
    updateBookmarkStatus(bookmarkId, 'failed', (err as Error).message);
  }
}

/**
 * Ingest a brand new bookmark: dedup, insert, queue, and process.
 * Used by collectors and the Discord bot.
 */
export async function ingestBookmark(input: BookmarkInput): Promise<number | null> {
  const normalized = normalizeUrl(input.url);
  const urlHash = hashUrl(normalized);

  const existing = getBookmarkByUrlHash(urlHash);
  if (existing) {
    logger.info({ url: input.url }, 'Duplicate URL, skipping');
    return null;
  }

  const bookmarkId = insertBookmark({
    url: normalized,
    urlHash,
    title: input.title,
    source: input.source,
    sourceId: input.sourceId,
    mediaType: input.mediaType,
    sourceMetadata: input.sourceMetadata,
    collectedAt: input.collectedAt,
    status: 'pending',
  });

  addToProcessingQueue(bookmarkId);
  return bookmarkId;
}
