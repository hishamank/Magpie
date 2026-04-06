export type ExtractionStatus =
  | 'success'
  | 'paywall'
  | 'rate_limited'
  | 'content_removed'
  | 'error';

export interface MediaAttachment {
  type: 'image' | 'video' | 'audio';
  sourceUrl: string;
  localPath?: string;
  mimeType?: string;
  altText?: string;
  ocrText?: string;
  transcription?: string;
}

export interface ExtractedContent {
  title: string;
  text: string;
  html?: string;
  markdown?: string;
  author?: string;
  publishedAt?: string;
  images?: string[];
  links?: string[];
  media?: MediaAttachment[];
  metadata?: Record<string, unknown>;
}

export interface ExtractionResult {
  status: ExtractionStatus;
  content: ExtractedContent | null;
  handlerName?: string;
  statusDetail?: string;
  retryAfter?: number;
}

/** Handler that returns typed ExtractionResult */
export type Handler = (url: string, sourceMetadata?: Record<string, unknown>) => Promise<ExtractionResult>;

/** Legacy handler that returns bare ExtractedContent (used during migration) */
export type LegacyHandler = (url: string, sourceMetadata?: Record<string, unknown>) => Promise<ExtractedContent>;
