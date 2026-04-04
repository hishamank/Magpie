import type { ExtractedContent } from './types.js';
import { runCommand } from '../utils/subprocess.js';
import { config } from '../config.js';
import { getLogger } from '../utils/logger.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const logger = getLogger('extractor:youtube');

interface Chapter {
  title: string;
  start_time: number;
  end_time: number;
}

interface SubtitleLine {
  start: number;
  text: string;
}

export async function extractYouTube(url: string, sourceMetadata?: Record<string, unknown>): Promise<ExtractedContent> {
  logger.info({ url }, 'Extracting YouTube video');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkb-yt-'));
  const hasCookies = fs.existsSync(config.youtube.cookiesPath);

  try {
    // Use --write-info-json instead of --dump-json so subtitle files are also written
    const args = [
      '--write-info-json',
      '--write-subs',         // manual/human subs first
      '--write-auto-sub',     // auto-generated as fallback
      '--sub-lang', 'en',
      '--skip-download',
      '-o', path.join(tmpDir, '%(id)s'),
    ];

    // Pass cookies for age-restricted / member-only content
    if (hasCookies) {
      args.push('--cookies', config.youtube.cookiesPath);
    }

    args.push(url);

    await runCommand('yt-dlp', args, { timeout: 60_000 });

    // Read metadata from the info.json file
    const infoFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.info.json'));
    if (infoFiles.length === 0) {
      throw new Error('yt-dlp did not produce info.json');
    }
    const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, infoFiles[0]), 'utf-8')) as Record<string, unknown>;
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
    const chapters = meta.chapters as Chapter[] || [];
    const thumbnailUrl = meta.thumbnail as string || '';

    // Read subtitles — prefer manual (no .auto. in filename) over auto-generated
    const subtitleFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.vtt') || f.endsWith('.srt'));
    const manualSub = subtitleFiles.find(f => !f.includes('.auto.'));
    const subtitleFile = manualSub || subtitleFiles[0];
    const subType = manualSub ? 'manual' : (subtitleFiles.length > 0 ? 'auto' : 'none');

    let rawLines: SubtitleLine[] = [];
    if (subtitleFile) {
      const content = fs.readFileSync(path.join(tmpDir, subtitleFile), 'utf-8');
      rawLines = parseSubtitleLines(content);
    }

    // Build the text body
    let text: string;
    if (rawLines.length > 0 && chapters.length > 0) {
      // Chapter-aligned transcript — structured and easy for the LLM to classify
      text = buildChapterTranscript(rawLines, chapters);
    } else if (rawLines.length > 0) {
      // Plain transcript (no chapters)
      text = rawLines.map(l => l.text).join(' ');
    } else {
      // No transcript at all — use description
      text = description;
    }

    // Append chapter list at the end if chapters exist but we didn't align
    const chapterList = chapters.length > 0
      ? '\n\nChapters:\n' + chapters.map(c => `- [${formatDuration(c.start_time)}] ${c.title}`).join('\n')
      : '';

    // Only add the chapter list if we didn't already embed chapters in the transcript
    const finalText = (rawLines.length > 0 && chapters.length > 0)
      ? text  // chapters are already inline
      : text + chapterList;

    return {
      title,
      text: finalText,
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
        hasTranscript: rawLines.length > 0,
        subtitleType: subType,
      },
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Parse VTT/SRT into timestamped lines for chapter alignment.
 */
function parseSubtitleLines(content: string): SubtitleLine[] {
  const lines = content.split('\n');
  const result: SubtitleLine[] = [];
  const seen = new Set<string>();
  let currentTime = 0;

  for (const line of lines) {
    // Parse timestamp line: "00:01:23.456 --> 00:01:25.789"
    const timeMatch = line.match(/^(\d{2}):(\d{2}):(\d{2})[.,]\d+\s*-->/);
    if (timeMatch) {
      currentTime = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]);
      continue;
    }

    // Skip non-content lines
    if (line.match(/^\d+$/) || line.startsWith('WEBVTT') || line.startsWith('Kind:') || line.startsWith('Language:') || line.trim() === '') {
      continue;
    }

    const clean = line.replace(/<[^>]+>/g, '').trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      result.push({ start: currentTime, text: clean });
    }
  }

  return result;
}

/**
 * Build a transcript organized by chapters.
 * Each chapter gets a heading and the transcript lines that fall within it.
 */
function buildChapterTranscript(lines: SubtitleLine[], chapters: Chapter[]): string {
  const sections: string[] = [];

  for (const chapter of chapters) {
    const chapterLines = lines
      .filter(l => l.start >= chapter.start_time && l.start < chapter.end_time)
      .map(l => l.text);

    if (chapterLines.length === 0) continue;

    sections.push(
      `## ${chapter.title} [${formatDuration(chapter.start_time)}]\n\n${chapterLines.join(' ')}`
    );
  }

  // Catch any lines before the first chapter or after the last
  const coveredRange = chapters.length > 0
    ? { start: chapters[0].start_time, end: chapters[chapters.length - 1].end_time }
    : { start: 0, end: 0 };

  const before = lines.filter(l => l.start < coveredRange.start).map(l => l.text);
  const after = lines.filter(l => l.start >= coveredRange.end).map(l => l.text);

  const parts: string[] = [];
  if (before.length > 0) parts.push(before.join(' '));
  parts.push(...sections);
  if (after.length > 0) parts.push(after.join(' '));

  return parts.join('\n\n');
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
