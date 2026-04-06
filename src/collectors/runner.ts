import { collectGitHubStars } from './github.js';
import { collectRaindropBookmarks } from './raindrop.js';
import { collectYouTubeBookmarks } from './youtube.js';
import { collectTwitterBookmarks } from './twitter.js';
import { collectRedditSaved } from './reddit.js';
import { ingestBookmark } from '../processor/pipeline.js';
import { getExistingSourceIds, updateCollectorState, getCollectorState } from '../db/queries.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('collector:runner');

type CollectorFn = (options?: { limit?: number }) => Promise<import('./types.js').BookmarkInput[]>;

const collectors: Record<string, CollectorFn> = {
  github: collectGitHubStars,
  raindrop: collectRaindropBookmarks,
  youtube: collectYouTubeBookmarks,
  twitter: collectTwitterBookmarks,
  reddit: collectRedditSaved,
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
    const state = getCollectorState(src);
    if (state) {
      console.log(`  Last run: ${state.last_collected_at} (${state.items_collected} total collected)`);
    }

    try {
      const bookmarks = await collectFn({ limit: options.limit });
      console.log(`  Fetched ${bookmarks.length} bookmark(s) from API`);

      // Filter out items we already have by source_id (fast, no URL normalization needed)
      const existingIds = getExistingSourceIds(src);
      const newBookmarks = bookmarks.filter(b => {
        if (!b.sourceId) return true; // no source ID, let URL dedup handle it
        return !existingIds.has(b.sourceId);
      });
      console.log(`  New: ${newBookmarks.length}, Already known: ${bookmarks.length - newBookmarks.length}`);

      if (options.dryRun) {
        for (const b of newBookmarks.slice(0, 20)) {
          console.log(`  [new] ${b.title?.slice(0, 60) || b.url}`);
        }
        if (newBookmarks.length > 20) {
          console.log(`  ... and ${newBookmarks.length - 20} more`);
        }
        continue;
      }

      let added = 0;
      let skipped = 0;
      for (const b of newBookmarks) {
        const id = await ingestBookmark(b);
        if (id) {
          added++;
        } else {
          skipped++; // URL dedup caught it
        }
      }
      console.log(`  Added: ${added}, Skipped (URL dupes): ${skipped}`);

      // Update collector state
      const lastId = bookmarks[0]?.sourceId;
      updateCollectorState(src, lastId, added);
    } catch (err) {
      logger.error({ src, err }, 'Collector failed');
      console.log(`  Error: ${(err as Error).message}`);
    }
  }
}
