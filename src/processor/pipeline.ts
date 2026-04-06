import fs from 'node:fs';
import path from 'node:path';
import { extractContent, closeBrowser } from '../extractors/registry.js';
import { classifyContent } from './classifier.js';
import { archiveContent } from './archiver.js';
import { processKeywords, updateKeywordLinks, computeRelatedBookmarks } from './keywords.js';
import { enrichRelationships } from './enricher.js';
import { compileObsidianNote } from '../obsidian/compiler.js';
import { updateAllIndexFiles } from '../obsidian/indexer.js';
import { computeSimhash } from '../utils/hash.js';
import { config } from '../config.js';
import {
  getBookmarkByUrlHash,
  insertBookmark,
  updateBookmarkFull,
  updateBookmarkStatus,
  updateObsidianPath,
  incrementQueueAttempt,
  removeFromQueue,
  addToProcessingQueue,
  deleteBookmark,
} from '../db/queries.js';
import { normalizeUrl, hashUrl } from '../processor/dedup.js';
import type { BookmarkInput } from '../collectors/types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('processor');

/**
 * Append an entry to the vault operations log.
 * Format: ## [YYYY-MM-DD] ingest | Title — category, source
 * Parseable with: grep "^## \[" _log.md | tail -5
 */
function appendToLog(title: string, category: string, source: string, url: string): void {
  try {
    const logPath = path.join(config.vault.path, '_log.md');
    const date = new Date().toISOString().slice(0, 10);
    const cleanTitle = (title || 'Untitled').replace(/\n/g, ' ').slice(0, 120);

    // Create the file with header if it doesn't exist
    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, '# Operations Log\n\nChronological record of all wiki operations.\n\n', 'utf-8');
    }

    const entry = `## [${date}] ingest | ${cleanTitle}\n- **Category:** ${category} | **Source:** ${source}\n- **URL:** ${url}\n\n`;
    fs.appendFileSync(logPath, entry, 'utf-8');
  } catch {
    // Never let logging break processing
  }
}

/**
 * Process a bookmark that already exists in the DB (called from the `process` command).
 * The bookmarkId parameter is the existing row ID.
 */
export async function processBookmark(input: BookmarkInput, bookmarkId: number): Promise<void> {
  logger.info({ url: input.url, bookmarkId }, 'Processing bookmark');

  incrementQueueAttempt(bookmarkId);
  updateBookmarkStatus(bookmarkId, 'processing');

  try {
    // Step 1: Extract content (with overall timeout to prevent hangs)
    const EXTRACT_TIMEOUT = 90_000; // 90s max for any single extraction
    const content = await Promise.race([
      extractContent(input.url, input.sourceMetadata),
      new Promise<never>((_, reject) =>
        setTimeout(async () => {
          // Force-close any Playwright browsers so the process can exit
          await closeBrowser().catch(() => {});
          reject(new Error(`Extraction timed out after ${EXTRACT_TIMEOUT / 1000}s`));
        }, EXTRACT_TIMEOUT),
      ),
    ]);

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

    // Step 6: Enrich relationships with LLM (Phase A)
    const enrichment = await enrichRelationships(
      bookmarkId,
      classification.summary,
      content.title || input.title || '',
      classification.category,
      classification.keywords,
    );

    // Use enriched summary if available, fall back to original
    const finalSummary = enrichment?.enrichedSummary || classification.summary;

    // Step 7: Update database
    // Prefer LLM-generated title (descriptive) over extractor title (often generic for tweets)
    const finalTitle = classification.title || content.title || input.title;
    // Pick the best thumbnail: first image from extraction (og:image, twitter:image, or YouTube thumbnail)
    const thumbnail = content.images?.[0];

    updateBookmarkFull(bookmarkId, {
      title: finalTitle,
      contentHash,
      rawContentPath: rawPath,
      extractedText: content.text,
      author: content.author,
      category: classification.category,
      subcategories: JSON.stringify(classification.subcategories),
      summary: finalSummary,
      actionability: classification.actionability,
      qualitySignal: classification.qualitySignal,
      thumbnail,
      processedAt: new Date().toISOString(),
      status: 'completed',
    });

    // Step 8: Compile Obsidian note (pass enrichment for rich relations)
    const obsidianPath = await compileObsidianNote(bookmarkId, enrichment);
    updateObsidianPath(bookmarkId, obsidianPath);

    // Step 9: Update index files
    updateAllIndexFiles();

    // Step 10: Append to operations log
    appendToLog(
      content.title || input.title || '',
      classification.category,
      input.source,
      input.url,
    );

    // Remove from queue on success
    removeFromQueue(bookmarkId);

    logger.info({ url: input.url, category: classification.category }, 'Bookmark processed successfully');
  } catch (err) {
    const message = (err as Error).message || '';

    // Detect permanently unavailable content
    if (isUnavailable(message)) {
      logger.warn({ url: input.url }, 'Content permanently unavailable, deleting bookmark');
      deleteBookmark(bookmarkId);
      return;
    }

    logger.error({ url: input.url, err }, 'Failed to process bookmark');
    updateBookmarkStatus(bookmarkId, 'failed', message);
  }
}

const UNAVAILABLE_PATTERNS = [
  /video unavailable/i,
  /private video/i,
  /video has been removed/i,
  /account.*terminated/i,
  /this tweet.*deleted/i,
  /this post.*unavailable/i,
  /HTTP 404/i,
  /HTTP 410/i,
  /page not found/i,
  /content.*not available/i,
];

function isUnavailable(errorMessage: string): boolean {
  return UNAVAILABLE_PATTERNS.some(p => p.test(errorMessage));
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
