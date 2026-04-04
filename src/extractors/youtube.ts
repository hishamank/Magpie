import type { Extractor, ExtractedContent } from './types.js';
import { runCommand } from '../utils/subprocess.js';
import { getLogger } from '../utils/logger.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const logger = getLogger('extractor:youtube');

export class YouTubeExtractor implements Extractor {
  async extract(url: string, sourceMetadata?: Record<string, unknown>): Promise<ExtractedContent> {
    logger.info({ url }, 'Extracting YouTube video');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkb-yt-'));

    try {
      // Get metadata and auto-subtitles
      const { stdout } = await runCommand('yt-dlp', [
        '--dump-json',
        '--write-auto-sub',
        '--sub-lang', 'en',
        '--skip-download',
        '-o', path.join(tmpDir, '%(id)s'),
        url,
      ], { timeout: 60_000 });

      const meta = JSON.parse(stdout) as Record<string, unknown>;
      const videoId = meta.id as string;
      const title = meta.title as string || '';
      const description = meta.description as string || '';
      const channel = meta.channel as string || meta.uploader as string || '';
      const duration = meta.duration as number || 0;
      const uploadDate = meta.upload_date as string || '';
      const viewCount = meta.view_count as number | undefined;
      const likeCount = meta.like_count as number | undefined;
      const tags = meta.tags as string[] || [];
      const categories = meta.categories as string[] || [];
      const chapters = meta.chapters as { title: string; start_time: number }[] || [];
      const thumbnailUrl = meta.thumbnail as string || '';

      // Try to read subtitles
      let transcript = '';
      const subtitleFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.vtt') || f.endsWith('.srt'));
      if (subtitleFiles.length > 0) {
        const subtitleContent = fs.readFileSync(path.join(tmpDir, subtitleFiles[0]), 'utf-8');
        transcript = parseSubtitles(subtitleContent);
      }

      const text = transcript || description;

      // Build chapter summary
      const chapterText = chapters.length > 0
        ? '\n\nChapters:\n' + chapters.map(c => `- [${formatDuration(c.start_time)}] ${c.title}`).join('\n')
        : '';

      return {
        title,
        text: text + chapterText,
        author: channel,
        publishedAt: uploadDate ? `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}` : undefined,
        images: thumbnailUrl ? [thumbnailUrl] : undefined,
        metadata: {
          ...sourceMetadata,
          videoId,
          duration,
          viewCount,
          likeCount,
          tags,
          categories,
          chapters,
          hasTranscript: transcript.length > 0,
        },
      };
    } finally {
      // Cleanup temp dir
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

function parseSubtitles(content: string): string {
  // Strip VTT/SRT formatting, timestamps, and duplicate lines
  const lines = content.split('\n');
  const textLines: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    // Skip timestamps, numeric indices, headers
    if (line.match(/^\d+$/) || line.match(/^[\d:.]+\s*-->/) || line.startsWith('WEBVTT') || line.startsWith('Kind:') || line.startsWith('Language:') || line.trim() === '') {
      continue;
    }
    // Strip HTML tags from subtitles
    const clean = line.replace(/<[^>]+>/g, '').trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      textLines.push(clean);
    }
  }

  return textLines.join(' ');
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
