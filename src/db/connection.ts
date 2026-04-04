import Database from 'better-sqlite3';
import { config } from '../config.js';
import { getLogger } from '../utils/logger.js';
import fs from 'node:fs';
import path from 'node:path';

const logger = getLogger('db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    // Ensure directory exists
    const dir = path.dirname(config.db.path);
    fs.mkdirSync(dir, { recursive: true });

    db = new Database(config.db.path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    logger.info({ path: config.db.path }, 'Database connection opened');
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}
