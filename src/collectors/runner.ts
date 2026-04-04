import { collectGitHubStars } from './github.js';
import { collectRaindropBookmarks } from './raindrop.js';
import { collectYouTubeBookmarks } from './youtube.js';
import { collectTwitterBookmarks } from './twitter.js';
import { ingestBookmark } from '../processor/pipeline.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('collector:runner');

type CollectorFn = (options?: { limit?: number }) => Promise<import('./types.js').BookmarkInput[]>;

const collectors: Record<string, CollectorFn> = {
  github: collectGitHubStars,
  raindrop: collectRaindropBookmarks,
  youtube: collectYouTubeBookmarks,
  twitter: collectTwitterBookmarks,
};

export async function runCollector(
  source: string | undefined,
  options: { limit?: number; dryRun?: boolean },
): Promise<void> {
  const sources = source ? [source] : Object.keys(collectors);

  for (const src of sources) {
    const collectFn = collectors[src];
    if (!collectFn) {
      console.log(`Unknown source: ${src}. Available: ${Object.keys(collectors).join(', ')}`);
      continue;
    }

    console.log(`\nCollecting from: ${src}`);
    try {
      const bookmarks = await collectFn({ limit: options.limit });
      console.log(`  Found ${bookmarks.length} bookmark(s)`);

      if (options.dryRun) {
        for (const b of bookmarks.slice(0, 20)) {
          console.log(`  [${b.source}] ${b.title?.slice(0, 60) || b.url}`);
        }
        if (bookmarks.length > 20) {
          console.log(`  ... and ${bookmarks.length - 20} more`);
        }
        continue;
      }

      let added = 0;
      let skipped = 0;
      for (const b of bookmarks) {
        const id = await ingestBookmark(b);
        if (id) {
          added++;
        } else {
          skipped++;
        }
      }
      console.log(`  Added: ${added}, Skipped (duplicates): ${skipped}`);
    } catch (err) {
      logger.error({ src, err }, 'Collector failed');
      console.log(`  Error: ${(err as Error).message}`);
    }
  }
}
