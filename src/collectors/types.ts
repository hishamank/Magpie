export interface BookmarkInput {
  url: string;
  title?: string;
  source: 'twitter' | 'youtube' | 'github' | 'raindrop' | 'discord' | 'manual';
  sourceId?: string;
  mediaType?: 'article' | 'video' | 'repo' | 'tweet' | 'thread' | 'paper' | 'pdf' | 'other';
  sourceMetadata?: Record<string, unknown>;
  collectedAt?: Date;
}
