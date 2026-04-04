import cron from 'node-cron';
import { runCollector } from '../collectors/runner.js';
import { getPendingBookmarks } from '../db/queries.js';
import { processBookmark } from '../processor/pipeline.js';
import { updateAllIndexFiles } from '../obsidian/indexer.js';
import { startDiscordBot } from '../collectors/discord.js';
import { closeBrowser } from '../extractors/fallback.js';
import { closeDb } from '../db/connection.js';
import { config } from '../config.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('scheduler');

export async function startServe(): Promise<void> {
  logger.info('Starting serve mode');

  // Start Discord bot if configured
  if (config.discord.botToken) {
    try {
      await startDiscordBot();
      logger.info('Discord bot started');
    } catch (err) {
      logger.error({ err }, 'Failed to start Discord bot');
    }
  }

  // Twitter collector: every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    logger.info('Running Twitter collector');
    try { await runCollector('twitter', {}); } catch (err) { logger.error({ err }, 'Twitter collector failed'); }
  });

  // YouTube collector: every 12 hours
  cron.schedule('0 */12 * * *', async () => {
    logger.info('Running YouTube collector');
    try { await runCollector('youtube', {}); } catch (err) { logger.error({ err }, 'YouTube collector failed'); }
  });

  // GitHub collector: every 24 hours
  cron.schedule('0 3 * * *', async () => {
    logger.info('Running GitHub collector');
    try { await runCollector('github', {}); } catch (err) { logger.error({ err }, 'GitHub collector failed'); }
  });

  // Raindrop collector: every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    logger.info('Running Raindrop collector');
    try { await runCollector('raindrop', {}); } catch (err) { logger.error({ err }, 'Raindrop collector failed'); }
  });

  // Process queue: every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    logger.info('Processing pending bookmarks');
    try {
      const pending = getPendingBookmarks(10);
      for (const bookmark of pending) {
        await processBookmark({
          url: bookmark.url,
          title: bookmark.title ?? undefined,
          source: bookmark.source as 'manual',
          sourceId: bookmark.source_id ?? undefined,
          mediaType: bookmark.media_type as 'article' | undefined,
          sourceMetadata: bookmark.source_metadata ? JSON.parse(bookmark.source_metadata) : undefined,
        }, bookmark.id);
      }
      if (pending.length > 0) {
        updateAllIndexFiles();
      }
    } catch (err) {
      logger.error({ err }, 'Processing failed');
    }
  });

  logger.info('Cron jobs scheduled. Press Ctrl+C to stop.');

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    await closeBrowser();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep process alive
  await new Promise(() => {});
}
