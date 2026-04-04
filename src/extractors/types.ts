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

export interface Extractor {
  extract(url: string, sourceMetadata?: Record<string, unknown>): Promise<ExtractedContent>;
}
