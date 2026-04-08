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

interface ProviderEnvConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model?: string;
}

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; envKey: string; envModel: string }> = {
  local:      { baseUrl: process.env.LLM_SERVER_URL || 'http://localhost:8080', envKey: '', envModel: '' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY', envModel: 'OPENROUTER_MODEL' },
  groq:       { baseUrl: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY', envModel: 'GROQ_MODEL' },
  nvidia:     { baseUrl: 'https://integrate.api.nvidia.com/v1', envKey: 'NVIDIA_API_KEY', envModel: 'NVIDIA_MODEL' },
  gemini:     { baseUrl: '', envKey: '', envModel: 'GEMINI_MODEL' }, // uses gemini-cli subprocess, no API key needed
};

function parseProviderChain(): ProviderEnvConfig[] {
  const raw = process.env.LLM_STEP2_PROVIDERS || 'local';
  return raw.split(',').map(name => name.trim()).filter(Boolean).map(name => {
    const defaults = PROVIDER_DEFAULTS[name];
    if (!defaults) {
      return { name, baseUrl: process.env.LLM_SERVER_URL || 'http://localhost:8080' };
    }
    return {
      name,
      baseUrl: defaults.baseUrl,
      apiKey: defaults.envKey ? process.env[defaults.envKey] : undefined,
      model: defaults.envModel ? process.env[defaults.envModel] : undefined,
    };
  });
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
    step2Providers: parseProviderChain(),
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
