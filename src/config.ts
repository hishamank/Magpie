import 'dotenv/config';
import path from 'node:path';

function resolveFromRoot(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(process.cwd(), p);
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
  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN || '',
    channelId: process.env.DISCORD_CHANNEL_ID || '',
  },
  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
} as const;
