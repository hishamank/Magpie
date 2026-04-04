import { runCommand } from '../utils/subprocess.js';
import { config } from '../config.js';
import type { BookmarkInput } from './types.js';
import { getLogger } from '../utils/logger.js';
import fs from 'node:fs';

const logger = getLogger('collector:youtube');

export async function collectYouTubeBookmarks(options?: { limit?: number }): Promise<BookmarkInput[]> {
  const bookmarks: BookmarkInput[] = [];
  const limit = options?.limit ?? Infinity;

  logger.info('Collecting YouTube bookmarks');

  // Build cookies argument
  const cookieArgs: string[] = [];
  if (config.youtube.cookiesPath && fs.existsSync(config.youtube.cookiesPath)) {
    cookieArgs.push('--cookies', config.youtube.cookiesPath);
  } else {
    cookieArgs.push('--cookies-from-browser', 'chrome');
  }

  // Collect from Watch Later
  try {
    const watchLater = await collectPlaylist(
      'https://www.youtube.com/playlist?list=WL',
      cookieArgs,
      limit,
    );
    bookmarks.push(...watchLater);
    logger.info({ count: watchLater.length }, 'Watch Later collected');
  } catch (err) {
    logger.error({ err }, 'Failed to collect Watch Later');
  }

  // Collect from Liked Videos
  try {
    const liked = await collectPlaylist(
      'https://www.youtube.com/playlist?list=LL',
      cookieArgs,
      Math.max(0, limit - bookmarks.length),
    );
    bookmarks.push(...liked);
    logger.info({ count: liked.length }, 'Liked videos collected');
  } catch (err) {
    logger.error({ err }, 'Failed to collect Liked Videos');
  }

  logger.info({ count: bookmarks.length }, 'YouTube bookmarks collected');
  return bookmarks;
}

async function collectPlaylist(
  playlistUrl: string,
  cookieArgs: string[],
  limit: number,
): Promise<BookmarkInput[]> {
  const { stdout, stderr } = await runCommand('yt-dlp', [
    ...cookieArgs,
    '--flat-playlist',
    '--dump-json',
    playlistUrl,
  ], { timeout: 120_000 });

  if (stderr) {
    logger.debug({ stderr: stderr.slice(0, 500) }, 'yt-dlp stderr');
  }

  const bookmarks: BookmarkInput[] = [];
  const lines = stdout.trim().split('\n').filter(Boolean);

  for (const line of lines) {
    if (bookmarks.length >= limit) break;

    try {
      const meta = JSON.parse(line) as Record<string, unknown>;
      const videoId = meta.id as string;
      const url = meta.url as string || `https://www.youtube.com/watch?v=${videoId}`;

      bookmarks.push({
        url,
        title: meta.title as string || undefined,
        source: 'youtube',
        sourceId: videoId,
        mediaType: 'video',
        sourceMetadata: {
          channel: meta.channel || meta.uploader,
          duration: meta.duration,
          uploadDate: meta.upload_date,
          description: (meta.description as string || '').slice(0, 500),
        },
        collectedAt: new Date(),
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to parse yt-dlp JSON line');
    }
  }

  return bookmarks;
}
