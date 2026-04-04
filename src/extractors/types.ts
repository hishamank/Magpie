export interface ExtractedContent {
  title: string;
  text: string;
  html?: string;
  author?: string;
  publishedAt?: string;
  images?: string[];
  links?: string[];
  metadata?: Record<string, unknown>;
}

/** Handler function signature — each service exports one of these */
export type Handler = (url: string, sourceMetadata?: Record<string, unknown>) => Promise<ExtractedContent>;
