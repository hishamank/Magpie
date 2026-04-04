import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { ExtractedContent } from '../extractors/types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('archiver');

export async function archiveContent(
  bookmarkId: number,
  source: string,
  content: ExtractedContent,
): Promise<string> {
  // Determine subfolder based on source
  const sourceDir = getSourceDir(source);
  const dateDir = new Date().toISOString().slice(0, 7); // 2026-04
  const dir = path.join(config.archive.path, sourceDir, dateDir);

  fs.mkdirSync(dir, { recursive: true });

  // Save HTML content if available, otherwise save text
  const ext = content.html ? 'html' : 'txt';
  const filename = `${bookmarkId}.${ext}`;
  const filePath = path.join(dir, filename);

  const data = content.html || content.text;
  fs.writeFileSync(filePath, data, 'utf-8');

  // Return relative path from archive root
  const relativePath = path.relative(config.archive.path, filePath);
  logger.debug({ bookmarkId, path: relativePath }, 'Content archived');
  return relativePath;
}

function getSourceDir(source: string): string {
  switch (source) {
    case 'twitter': return 'twitter';
    case 'youtube': return 'youtube';
    case 'github': return 'github';
    case 'discord':
    case 'raindrop':
    case 'manual':
    default:
      return 'articles';
  }
}
