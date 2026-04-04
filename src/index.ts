#!/usr/bin/env node
import { Command } from 'commander';
import { initSchema } from './db/schema.js';
import { closeDb } from './db/connection.js';
import {
  insertBookmark,
  addToProcessingQueue,
  getBookmarkByUrlHash,
  getStats,
  getQueueStats,
  searchBookmarks,
  getPendingBookmarks,
} from './db/queries.js';
import { normalizeUrl } from './utils/url.js';
import { hashUrl } from './utils/hash.js';
import { config } from './config.js';
import { getLogger } from './utils/logger.js';
import { processBookmark } from './processor/pipeline.js';
import { updateAllIndexFiles } from './obsidian/indexer.js';

const logger = getLogger('cli');

const program = new Command();

program
  .name('bookmark-kb')
  .description('Personal bookmark knowledge base with LLM classification')
  .version('1.0.0');

program
  .command('add <url>')
  .description('Manually add a single URL for processing')
  .option('-t, --title <title>', 'Optional title for the bookmark')
  .option('-s, --source <source>', 'Source identifier', 'manual')
  .action(async (url: string, opts: { title?: string; source?: string }) => {
    initSchema();
    const normalized = normalizeUrl(url);
    const urlHash = hashUrl(normalized);

    const existing = getBookmarkByUrlHash(urlHash);
    if (existing) {
      console.log(`Bookmark already exists (id: ${existing.id}, status: ${existing.status})`);
      closeDb();
      return;
    }

    const id = insertBookmark({
      url: normalized,
      urlHash,
      title: opts.title,
      source: (opts.source as 'manual') ?? 'manual',
      status: 'pending',
    });
    addToProcessingQueue(id);
    console.log(`Added bookmark (id: ${id}): ${normalized}`);
    closeDb();
  });

program
  .command('process')
  .description('Process all pending bookmarks in the queue')
  .option('-l, --limit <n>', 'Max bookmarks to process', '10')
  .option('--dry-run', 'Show what would be processed without doing it')
  .action(async (opts: { limit: string; dryRun?: boolean }) => {
    initSchema();
    const limit = parseInt(opts.limit, 10);
    const pending = getPendingBookmarks(limit);

    if (pending.length === 0) {
      console.log('No pending bookmarks to process.');
      closeDb();
      return;
    }

    console.log(`Found ${pending.length} pending bookmark(s)`);

    if (opts.dryRun) {
      for (const b of pending) {
        console.log(`  [${b.id}] ${b.url} (${b.source})`);
      }
      closeDb();
      return;
    }

    for (const bookmark of pending) {
      console.log(`Processing [${bookmark.id}]: ${bookmark.url}`);
      try {
        await processBookmark({
          url: bookmark.url,
          title: bookmark.title ?? undefined,
          source: bookmark.source as 'manual',
          sourceId: bookmark.source_id ?? undefined,
          mediaType: bookmark.media_type as 'article' | undefined,
          sourceMetadata: bookmark.source_metadata ? JSON.parse(bookmark.source_metadata) : undefined,
        }, bookmark.id);
      } catch (err) {
        logger.error({ err, bookmarkId: bookmark.id }, 'Failed to process bookmark');
      }
    }

    closeDb();
    console.log('Processing complete.');
  });

program
  .command('status')
  .description('Show processing queue status and stats')
  .action(() => {
    initSchema();
    const stats = getStats();
    const queue = getQueueStats();

    console.log('\n=== Bookmark KB Status ===\n');
    console.log(`Total bookmarks: ${stats.total}`);
    console.log(`  Pending:    ${stats.pending}`);
    console.log(`  Processing: ${stats.processing}`);
    console.log(`  Completed:  ${stats.completed}`);
    console.log(`  Failed:     ${stats.failed}`);
    console.log(`  Skipped:    ${stats.skipped}`);

    if (stats.bySource.length > 0) {
      console.log('\nBy source:');
      for (const { source, count } of stats.bySource) {
        console.log(`  ${source}: ${count}`);
      }
    }

    if (stats.byCategory.length > 0) {
      console.log('\nBy category:');
      for (const { category, count } of stats.byCategory) {
        console.log(`  ${category}: ${count}`);
      }
    }

    console.log(`\nQueue: ${queue.total} total, ${queue.ready} ready, ${queue.retrying} retrying`);
    closeDb();
  });

program
  .command('health')
  .description('Check llama.cpp server connection, DB status, etc.')
  .action(async () => {
    console.log('\n=== Health Check ===\n');

    // Check DB
    try {
      initSchema();
      const stats = getStats();
      console.log(`[OK] Database: ${config.db.path} (${stats.total} bookmarks)`);
      closeDb();
    } catch (err) {
      console.log(`[FAIL] Database: ${(err as Error).message}`);
    }

    // Check llama.cpp server
    try {
      const resp = await fetch(`${config.llm.url}/health`);
      if (resp.ok) {
        const data = await resp.json() as { status?: string };
        console.log(`[OK] llama.cpp: ${config.llm.url} (status: ${data.status || 'ok'})`);
      } else {
        console.log(`[FAIL] llama.cpp: HTTP ${resp.status}`);
      }
    } catch (err) {
      console.log(`[FAIL] llama.cpp: ${(err as Error).message}`);
    }

    // Check vault path
    const fs = await import('node:fs');
    if (fs.existsSync(config.vault.path)) {
      console.log(`[OK] Vault: ${config.vault.path}`);
    } else {
      console.log(`[WARN] Vault: ${config.vault.path} (does not exist)`);
    }

    // Check archive path
    if (fs.existsSync(config.archive.path)) {
      console.log(`[OK] Archive: ${config.archive.path}`);
    } else {
      console.log(`[WARN] Archive: ${config.archive.path} (does not exist)`);
    }
  });

program
  .command('search <query>')
  .description('Full-text search across bookmarks')
  .option('-l, --limit <n>', 'Max results', '20')
  .action((query: string, opts: { limit: string }) => {
    initSchema();
    const results = searchBookmarks(query, parseInt(opts.limit, 10));

    if (results.length === 0) {
      console.log('No results found.');
      closeDb();
      return;
    }

    console.log(`Found ${results.length} result(s):\n`);
    for (const r of results) {
      console.log(`  [${r.id}] ${r.title || '(untitled)'}`);
      console.log(`       ${r.url}`);
      console.log(`       ${r.category || 'uncategorized'} | ${r.source} | ${r.status}`);
      if (r.summary) {
        console.log(`       ${r.summary.slice(0, 100)}...`);
      }
      console.log();
    }
    closeDb();
  });

program
  .command('reindex')
  .description('Regenerate all Obsidian index files')
  .action(() => {
    initSchema();
    updateAllIndexFiles();
    console.log('Index files regenerated.');
    closeDb();
  });

program
  .command('collect [source]')
  .description('Run a specific collector (twitter|youtube|github|raindrop) or all')
  .option('-l, --limit <n>', 'Limit number of items to collect')
  .option('--dry-run', 'Show what would be collected without doing it')
  .action(async (source: string | undefined, opts: { limit?: string; dryRun?: boolean }) => {
    initSchema();
    const { runCollector } = await import('./collectors/runner.js');
    await runCollector(source, {
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      dryRun: opts.dryRun,
    });
    closeDb();
  });

program
  .command('serve')
  .description('Start the Discord bot + scheduler (long-running)')
  .action(async () => {
    initSchema();
    const { startServe } = await import('./scheduler/cron.js');
    await startServe();
    // Keep running until signal
  });

program.parse();
