import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '../config.js';
import { visionCompletion } from '../llm/client.js';
import { runCommand } from '../utils/subprocess.js';
import { updateMediaAttachment } from '../db/queries.js';
import type { MediaAttachment } from './types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('extractor:media-processing');

const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/**
 * Analyze an image using the local LLM's vision capability.
 * Extracts text (OCR) and describes visual content — far richer than tesseract.
 */
export async function analyzeImage(localPath: string): Promise<string | null> {
  const absPath = path.isAbsolute(localPath)
    ? localPath
    : path.join(config.media.path, localPath);

  try {
    const buffer = fs.readFileSync(absPath);
    const base64 = buffer.toString('base64');
    const ext = path.extname(absPath).replace('.', '').toLowerCase();
    const mimeType = MIME_MAP[ext] || 'image/jpeg';

    const result = await visionCompletion(
      `Analyze this image thoroughly. Extract ALL text visible in the image (OCR). Then briefly describe any visual content (diagrams, charts, screenshots, photos) that provides context beyond the text. Focus on information that would be useful for classifying and understanding the content this image belongs to.

If the image contains only text, return just the text.
If the image is decorative or a logo with no useful information, respond with: [decorative image]

Return your response as plain text, no markdown formatting.`,
      base64,
      mimeType,
      { temperature: 0.1 },
    );

    const text = result.trim();
    if (!text || text === '[decorative image]') return null;
    return text;
  } catch (err) {
    const message = (err as Error).message || '';
    logger.warn({ localPath, error: message }, 'LLM image analysis failed');
    return null;
  }
}

/**
 * Transcribe an audio or video file using OpenAI Whisper (Python).
 * Outputs to a temp directory and reads the .txt result.
 */
export async function transcribeMedia(localPath: string): Promise<string | null> {
  const absPath = path.isAbsolute(localPath)
    ? localPath
    : path.join(config.media.path, localPath);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkb-whisper-'));

  try {
    const args = [
      absPath,
      '--model', config.whisper.model,
      '--output_dir', tmpDir,
      '--output_format', 'txt',
      '--language', 'en',
    ];

    await runCommand('whisper', args, { timeout: 600_000 }); // 10 min timeout

    // Whisper writes {filename}.txt in the output dir
    const txtFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.txt'));
    if (txtFiles.length === 0) {
      throw new Error('Whisper produced no output file');
    }

    const text = fs.readFileSync(path.join(tmpDir, txtFiles[0]), 'utf-8').trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    const message = (err as Error).message || '';
    if (/ENOENT|not found|command not found/i.test(message)) {
      logger.warn('whisper not installed, skipping transcription');
    } else {
      logger.warn({ localPath, error: message }, 'Transcription failed');
    }
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Process all media attachments for a bookmark.
 * Analyzes images with LLM vision, transcribes audio/video with Whisper.
 * Updates the MediaAttachment objects and the DB.
 */
export async function processAllMedia(
  bookmarkId: number,
  attachments: MediaAttachment[],
  dbIds: number[],
  options?: { hasExistingTranscript?: boolean },
): Promise<MediaAttachment[]> {
  const results: MediaAttachment[] = [];

  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i];
    const dbId = dbIds[i];
    const updated = { ...attachment };

    // Skip processing if no local file
    if (!attachment.localPath) {
      results.push(updated);
      continue;
    }

    if (attachment.type === 'image') {
      const ocrText = await analyzeImage(attachment.localPath);
      if (ocrText) {
        updated.ocrText = ocrText;
        if (dbId) updateMediaAttachment(dbId, { ocrText });
        logger.debug({ bookmarkId, localPath: attachment.localPath }, 'Image analysis complete');
      }
    }

    if ((attachment.type === 'audio' || attachment.type === 'video') && !options?.hasExistingTranscript) {
      const transcription = await transcribeMedia(attachment.localPath);
      if (transcription) {
        updated.transcription = transcription;
        if (dbId) updateMediaAttachment(dbId, { transcription });
        logger.debug({ bookmarkId, localPath: attachment.localPath }, 'Transcription complete');
      }
    }

    results.push(updated);
  }

  return results;
}

/**
 * Inline OCR and transcription results into markdown content.
 * Appends processed media text at the end of the document.
 */
export function inlineMediaContent(markdown: string, attachments: MediaAttachment[]): string {
  const sections: string[] = [];

  // Collect image analysis results
  const imageResults = attachments
    .filter(a => a.type === 'image' && a.ocrText)
    .map(a => `**Image** (${a.altText || a.sourceUrl}):\n${a.ocrText}`);

  if (imageResults.length > 0) {
    sections.push('---\n## Image Content\n\n' + imageResults.join('\n\n'));
  }

  // Collect transcriptions
  const transcriptions = attachments
    .filter(a => (a.type === 'audio' || a.type === 'video') && a.transcription)
    .map(a => `**${a.type === 'video' ? 'Video' : 'Audio'} Transcription:**\n${a.transcription}`);

  if (transcriptions.length > 0) {
    sections.push('---\n## Transcription\n\n' + transcriptions.join('\n\n'));
  }

  if (sections.length === 0) return markdown;

  return markdown + '\n\n' + sections.join('\n\n');
}
