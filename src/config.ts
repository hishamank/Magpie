import 'dotenv/config';
import path from 'node:path';

function resolveFromRoot(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(process.cwd(), p);
}

function parseRedditAccounts(): Array<{ clientId: string; clientSecret: string; username: string; password: string }> {
  const json = process.env.REDDIT_ACCOUNTS;
  if (json) {
    try { return JSON.parse(json); } catch { /* fall through to single-account */ }
  }

  // Single-account fallback
  const clientId = process.env.REDDIT_CLIENT_ID || '';
  const clientSecret = process.env.REDDIT_CLIENT_SECRET || '';
  const username = process.env.REDDIT_USERNAME || '';
  const password = process.env.REDDIT_PASSWORD || '';
  if (clientId && clientSecret && username && password) {
    return [{ clientId, clientSecret, username, password }];
  }
  return [];
}

export const config = {
  db: {
    path: resolveFromRoot(process.env.DB_PATH || './data/bookmark-kb.db'),
  },
  archive: {
    path: resolveFromRoot(process.env.ARCHIVE_PATH || './data/raw'),
  },
  vault: {
    path: resolveFromRoot(process.env.VAULT_PATH || './vault'),
  },
  llm: {
    url: process.env.LLM_SERVER_URL || 'http://localhost:8080',
  },
  twitter: {
    cookiesPath: resolveFromRoot(process.env.TWITTER_COOKIES_PATH || './cookies/twitter-cookies.json'),
  },
  youtube: {
    cookiesPath: resolveFromRoot(process.env.YOUTUBE_COOKIES_PATH || './cookies/youtube-cookies.txt'),
  },
  github: {
    token: process.env.GITHUB_TOKEN || '',
  },
  raindrop: {
    token: process.env.RAINDROP_TOKEN || '',
  },
  reddit: {
    accounts: parseRedditAccounts(),
  },
  media: {
    path: resolveFromRoot(process.env.MEDIA_PATH || './data/media'),
    maxImageSizeMb: parseInt(process.env.MEDIA_MAX_IMAGE_SIZE_MB || '10', 10),
    maxVideoSizeMb: parseInt(process.env.MEDIA_MAX_VIDEO_SIZE_MB || '500', 10),
  },
  whisper: {
    model: process.env.WHISPER_MODEL || 'base',
  },
  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN || '',
    channelId: process.env.DISCORD_CHANNEL_ID || '',
  },
  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
} as const;
