import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { runCommand } from '../utils/subprocess.js';
import { insertMediaAttachment } from '../db/queries.js';
import type { ExtractedContent, MediaAttachment } from './types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('extractor:media');

export interface MediaDownloadResult {
  attachment: MediaAttachment;
  dbId: number;
  success: boolean;
  error?: string;
}

/**
 * Discover all media in extracted content.
 * Merges content.media (from domain extractors), content.images, and any
 * media URLs found in HTML/markdown that aren't already tracked.
 */
export function discoverMedia(content: ExtractedContent, url: string): MediaAttachment[] {
  const seen = new Set<string>();
  const media: MediaAttachment[] = [];

  function add(attachment: MediaAttachment): void {
    if (!attachment.sourceUrl || seen.has(attachment.sourceUrl)) return;
    // Skip data URIs and tiny placeholders
    if (attachment.sourceUrl.startsWith('data:')) return;
    seen.add(attachment.sourceUrl);
    media.push(attachment);
  }

  // 1. From domain extractors (already structured)
  if (content.media) {
    for (const m of content.media) add(m);
  }

  // 2. From content.images array
  if (content.images) {
    for (const imgUrl of content.images) {
      add({ type: 'image', sourceUrl: imgUrl });
    }
  }

  // 3. Scan HTML for additional media not yet tracked
  if (content.html) {
    // Images
    const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
    let match;
    while ((match = imgRegex.exec(content.html)) !== null) {
      add({ type: 'image', sourceUrl: resolveUrl(match[1], url) });
    }

    // Videos
    const videoRegex = /<video[^>]+src=["']([^"']+)["']|<source[^>]+src=["']([^"']+)["']/gi;
    while ((match = videoRegex.exec(content.html)) !== null) {
      const src = match[1] || match[2];
      add({ type: 'video', sourceUrl: resolveUrl(src, url) });
    }

    // Audio
    const audioRegex = /<audio[^>]+src=["']([^"']+)["']|<source[^>]+src=["']([^"']+)["'][^>]+type=["']audio/gi;
    while ((match = audioRegex.exec(content.html)) !== null) {
      const src = match[1] || match[2];
      add({ type: 'audio', sourceUrl: resolveUrl(src, url) });
    }
  }

  return media;
}

/**
 * Download a single media file to the local media directory.
 */
async function downloadMedia(
  attachment: MediaAttachment,
  bookmarkId: number,
  source: string,
  index: number,
): Promise<MediaDownloadResult> {
  const dateDir = new Date().toISOString().slice(0, 7); // 2026-04
  const typeDir = attachment.type === 'image' ? 'images' : attachment.type === 'video' ? 'videos' : 'audio';
  const dir = path.join(config.media.path, typeDir, source, dateDir);

  fs.mkdirSync(dir, { recursive: true });

  try {
    // For YouTube videos, use yt-dlp
    if (attachment.type === 'video' && /youtube\.com|youtu\.be/.test(attachment.sourceUrl)) {
      return downloadYouTubeMedia(attachment, bookmarkId, dir);
    }

    // Standard HTTP download
    const resp = await fetch(attachment.sourceUrl, {
      headers: { 'User-Agent': 'bookmark-kb/1.0' },
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const contentType = resp.headers.get('content-type') || '';
    const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);

    // Check size limits
    const maxBytes = attachment.type === 'image'
      ? config.media.maxImageSizeMb * 1024 * 1024
      : config.media.maxVideoSizeMb * 1024 * 1024;

    if (contentLength > maxBytes) {
      throw new Error(`File too large: ${(contentLength / 1024 / 1024).toFixed(1)}MB exceeds ${attachment.type} limit`);
    }

    const ext = getExtension(attachment.sourceUrl, contentType);
    const filename = `${bookmarkId}_${index}.${ext}`;
    const filePath = path.join(dir, filename);

    const buffer = Buffer.from(await resp.arrayBuffer());

    // Double-check actual size
    if (buffer.length > maxBytes) {
      throw new Error(`File too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);
    }

    fs.writeFileSync(filePath, buffer);

    const localPath = path.relative(config.media.path, filePath);
    const updated: MediaAttachment = {
      ...attachment,
      localPath,
      mimeType: contentType.split(';')[0].trim() || undefined,
    };

    const dbId = insertMediaAttachment(bookmarkId, {
      type: attachment.type,
      sourceUrl: attachment.sourceUrl,
      localPath,
      mimeType: updated.mimeType,
      altText: attachment.altText,
      fileSize: buffer.length,
    });

    logger.debug({ bookmarkId, type: attachment.type, localPath }, 'Media downloaded');
    return { attachment: updated, dbId, success: true };
  } catch (err) {
    const error = (err as Error).message;
    logger.warn({ bookmarkId, url: attachment.sourceUrl, error }, 'Media download failed');

    // Still record the attachment in DB (without localPath) for tracking
    const dbId = insertMediaAttachment(bookmarkId, {
      type: attachment.type,
      sourceUrl: attachment.sourceUrl,
      altText: attachment.altText,
    });

    return { attachment, dbId, success: false, error };
  }
}

/**
 * Download YouTube video audio track via yt-dlp.
 */
async function downloadYouTubeMedia(
  attachment: MediaAttachment,
  bookmarkId: number,
  dir: string,
): Promise<MediaDownloadResult> {
  const outputTemplate = path.join(dir, `${bookmarkId}.%(ext)s`);

  try {
    // Download audio only (much smaller than video) — sufficient for transcription
    await runCommand('yt-dlp', [
      '-x',                        // extract audio
      '--audio-format', 'mp3',
      '--audio-quality', '5',      // medium quality
      '-o', outputTemplate,
      '--no-playlist',
      attachment.sourceUrl,
    ], { timeout: 300_000 }); // 5 min timeout

    // Find the downloaded file
    const files = fs.readdirSync(dir).filter(f => f.startsWith(`${bookmarkId}.`));
    if (files.length === 0) throw new Error('yt-dlp produced no output file');

    const downloadedFile = files[0];
    const filePath = path.join(dir, downloadedFile);
    const stats = fs.statSync(filePath);
    const localPath = path.relative(config.media.path, filePath);

    const updated: MediaAttachment = {
      ...attachment,
      type: 'audio', // it's now an audio file
      localPath,
      mimeType: 'audio/mpeg',
    };

    const dbId = insertMediaAttachment(bookmarkId, {
      type: 'audio',
      sourceUrl: attachment.sourceUrl,
      localPath,
      mimeType: 'audio/mpeg',
      fileSize: stats.size,
    });

    logger.info({ bookmarkId, localPath, sizeMb: (stats.size / 1024 / 1024).toFixed(1) }, 'YouTube audio downloaded');
    return { attachment: updated, dbId, success: true };
  } catch (err) {
    const error = (err as Error).message;
    logger.warn({ bookmarkId, url: attachment.sourceUrl, error }, 'YouTube download failed');

    const dbId = insertMediaAttachment(bookmarkId, {
      type: attachment.type,
      sourceUrl: attachment.sourceUrl,
    });

    return { attachment, dbId, success: false, error };
  }
}

export interface DownloadAllResult {
  attachments: MediaAttachment[];
  dbIds: number[];
}

/**
 * Download all media for a bookmark.
 * Runs downloads sequentially to be respectful of rate limits.
 */
export async function downloadAllMedia(
  content: ExtractedContent,
  bookmarkId: number,
  source: string,
  url: string,
): Promise<DownloadAllResult> {
  const discovered = discoverMedia(content, url);

  if (discovered.length === 0) return { attachments: [], dbIds: [] };

  logger.info({ bookmarkId, count: discovered.length }, 'Downloading media');

  const attachments: MediaAttachment[] = [];
  const dbIds: number[] = [];
  for (let i = 0; i < discovered.length; i++) {
    const result = await downloadMedia(discovered[i], bookmarkId, source, i);
    attachments.push(result.attachment);
    dbIds.push(result.dbId);
  }

  const successful = attachments.filter(r => r.localPath);
  logger.info({ bookmarkId, total: discovered.length, downloaded: successful.length }, 'Media download complete');

  return { attachments, dbIds };
}

// --- Helpers ---

function resolveUrl(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function getExtension(url: string, contentType: string): string {
  // Try from content-type first
  const mimeMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
  };

  const mime = contentType.split(';')[0].trim();
  if (mimeMap[mime]) return mimeMap[mime];

  // Try from URL
  const urlPath = new URL(url).pathname;
  const ext = path.extname(urlPath).replace('.', '').toLowerCase();
  if (ext && ext.length <= 5) return ext;

  // Fallback
  if (contentType.startsWith('image/')) return 'jpg';
  if (contentType.startsWith('video/')) return 'mp4';
  if (contentType.startsWith('audio/')) return 'mp3';
  return 'bin';
}
