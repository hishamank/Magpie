import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { slugify } from './templates.js';
import type { ExtractedContent } from '../extractors/types.js';
import type { BookmarkInput } from '../collectors/types.js';
import type { SkipReason } from '../processor/skip-gate.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('obsidian:minimal-compiler');

/**
 * Map a skip reason to the vault subfolder for its minimal notes.
 */
const REASON_FOLDER: Record<SkipReason, string> = {
  music_video: 'music',
};

/**
 * Write a minimal Obsidian note for a bookmark that the skip gate
 * decided not to process. Only frontmatter + thumbnail + link.
 *
 * Returns the vault-relative path to the written file.
 */
export function compileMinimalNote(
  bookmarkId: number,
  content: ExtractedContent,
  input: BookmarkInput,
  reason: SkipReason,
): string {
  const folder = REASON_FOLDER[reason];
  const title = content.title || input.title || 'Untitled';
  const date = (input.collectedAt ?? new Date()).toISOString().slice(0, 10);
  const processedDate = new Date().toISOString().slice(0, 10);
  const noteName = `${date}-${slugify(title)}`;
  const relativePath = path.join(folder, `${noteName}.md`);
  const fullPath = path.join(config.vault.path, relativePath);

  const thumbnail = content.images?.[0] || '';
  const author = content.author || '';

  const lines: string[] = [];
  lines.push('---');
  lines.push(`title: "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  lines.push(`url: ${input.url}`);
  lines.push(`source: ${input.source}`);
  lines.push(`type: ${reason}`);
  if (author) lines.push(`author: "${author.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  if (thumbnail) lines.push(`thumbnail: "${thumbnail}"`);
  lines.push('tags: [music, skipped]');
  lines.push(`collected: ${date}`);
  lines.push(`processed: ${processedDate}`);
  lines.push('---');
  lines.push('');
  if (thumbnail) {
    lines.push(`![](${thumbnail})`);
    lines.push('');
  }
  const linkLabel = input.source === 'youtube' ? 'Watch on YouTube' : 'Open';
  lines.push(`[${linkLabel}](${input.url})`);
  lines.push('');

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, lines.join('\n'), 'utf-8');

  logger.info({ bookmarkId, path: relativePath, reason }, 'Minimal Obsidian note written');
  return relativePath;
}
