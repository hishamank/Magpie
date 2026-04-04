import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { ContentIssue } from './bypass.js';

const LOG_PATH = path.join(path.dirname(config.db.path), 'extraction.jsonl');

export interface ExtractionLogEntry {
  timestamp: string;
  url: string;
  domain: string;
  handler: string;
  textLength: number;
  issues: ContentIssue[];
  bypassUsed: string | null;
  bypassSuccess: boolean;
  finalMethod: string;  // 'direct' | 'bypass:google-cache' | 'bypass:archive-org' | etc.
  error?: string;
}

/**
 * Append an extraction result to the log file.
 * One JSON object per line — easy to grep, parse, or load into sqlite later.
 */
export function logExtraction(entry: ExtractionLogEntry): void {
  try {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(LOG_PATH, line, 'utf-8');
  } catch {
    // Never let logging break extraction
  }
}
