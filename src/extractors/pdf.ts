import type { Extractor, ExtractedContent } from './types.js';
import { runCommand } from '../utils/subprocess.js';
import { getLogger } from '../utils/logger.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const logger = getLogger('extractor:pdf');

export class PDFExtractor implements Extractor {
  async extract(url: string, _sourceMetadata?: Record<string, unknown>): Promise<ExtractedContent> {
    logger.info({ url }, 'Extracting PDF');

    // Download to temp file
    const tmpFile = path.join(os.tmpdir(), `bkb-pdf-${Date.now()}.pdf`);

    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(60_000),
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} fetching PDF`);
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(tmpFile, buffer);

      // Try pdftotext (poppler-utils)
      let text = '';
      try {
        const { stdout } = await runCommand('pdftotext', [tmpFile, '-'], { timeout: 30_000 });
        text = stdout;
      } catch {
        logger.warn('pdftotext not available, using basic extraction');
        // Very basic PDF text extraction as fallback
        const raw = buffer.toString('utf-8');
        const textChunks = raw.match(/\(([^)]+)\)/g);
        if (textChunks) {
          text = textChunks.map(chunk => chunk.slice(1, -1)).join(' ');
        }
      }

      text = text.replace(/\n{3,}/g, '\n\n').trim();

      // Try to extract title from first line
      const firstLine = text.split('\n')[0]?.trim() || '';
      const title = firstLine.length > 10 && firstLine.length < 200
        ? firstLine
        : path.basename(url).replace(/\.pdf(\?.*)?$/i, '');

      return {
        title,
        text,
        metadata: { format: 'pdf', size: buffer.length },
      };
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  }
}
