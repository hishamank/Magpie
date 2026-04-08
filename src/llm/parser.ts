import { CONTENT_TYPE_SET, TYPE_METADATA_DEFAULTS } from './types.js';
import type { ContentType, TypeDetectionResult, TypeSpecificClassification } from './types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('llm-parser');

/** @deprecated Use TypeSpecificClassification instead */
export interface Classification {
  title?: string;
  category: string;
  subcategories: string[];
  summary: string;
  keywords: string[];
  actionability: 'reference' | 'to-read' | 'to-watch' | 'to-try' | 'to-buy';
  qualitySignal: 'quick-tip' | 'standard' | 'deep-dive' | 'comprehensive';
  language?: string;
}

const VALID_CATEGORIES = new Set([
  'tool', 'article', 'guide', 'paper', 'tutorial', 'recipe',
  'trading', 'movie', 'book', 'tweet-thread', 'repo', 'video-essay',
  'tip', 'news', 'opinion', 'music', 'meme', 'entertainment', 'other',
  // New types
  ...CONTENT_TYPE_SET,
]);

const VALID_ACTIONABILITY = new Set(['reference', 'to-read', 'to-watch', 'to-try', 'to-buy']);
const VALID_QUALITY = new Set(['quick-tip', 'standard', 'deep-dive', 'comprehensive']);

// --- Shared JSON extraction ---

function extractJson(raw: string): Record<string, unknown> {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON object found in LLM response');
  }

  let jsonStr = jsonMatch[0];
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Failed to parse JSON: ${(err as Error).message}\nRaw: ${jsonStr.slice(0, 200)}`);
  }
}

// --- Step 1: Type detection parser ---

export function parseTypeDetection(raw: string): TypeDetectionResult {
  const parsed = extractJson(raw);

  let type = typeof parsed.type === 'string' ? parsed.type.toLowerCase().trim() : 'other';
  if (!CONTENT_TYPE_SET.has(type)) {
    // Try to map common LLM variations
    const typeMap: Record<string, ContentType> = {
      'tutorial': 'guide',
      'how-to': 'guide',
      'howto': 'guide',
      'blog': 'article',
      'opinion': 'article',
      'essay': 'article',
      'tweet': 'social-post',
      'tweet-thread': 'social-post',
      'thread': 'social-post',
      'repo': 'tool',
      'library': 'tool',
      'framework': 'tool',
      'software': 'tool',
      'github': 'tool',
      'video': 'media',
      'video-essay': 'article',
      'music': 'media',
      'movie': 'media',
      'podcast': 'media',
      'film': 'media',
      'tv-show': 'media',
      'docs': 'reference',
      'documentation': 'reference',
      'cheatsheet': 'reference',
      'travel': 'location',
      'restaurant': 'location',
      'tip': 'article',
      'meme': 'other',
      'entertainment': 'other',
      'trading': 'article',
    };
    type = typeMap[type] || 'other';
  }

  logger.debug({ type }, 'Type detection parsed');
  return { type: type as ContentType };
}

// --- Step 2: Type-specific classification parser ---

export function parseTypeClassification(raw: string, expectedType: ContentType): TypeSpecificClassification {
  const parsed = extractJson(raw);

  const title = typeof parsed.title === 'string' && parsed.title.length > 0
    ? parsed.title
    : '';

  const subcategories = Array.isArray(parsed.subcategories)
    ? parsed.subcategories.filter((s): s is string => typeof s === 'string').slice(0, 3)
    : [];

  const summary = typeof parsed.summary === 'string'
    ? parsed.summary
    : 'No summary available.';

  const keywords = Array.isArray(parsed.keywords)
    ? parsed.keywords.filter((k): k is string => typeof k === 'string').slice(0, 12)
    : [];

  const actionability = typeof parsed.actionability === 'string' && VALID_ACTIONABILITY.has(parsed.actionability)
    ? parsed.actionability as TypeSpecificClassification['actionability']
    : 'reference';

  const qualitySignal = typeof parsed.qualitySignal === 'string' && VALID_QUALITY.has(parsed.qualitySignal)
    ? parsed.qualitySignal as TypeSpecificClassification['qualitySignal']
    : 'standard';

  const language = typeof parsed.language === 'string' ? parsed.language : undefined;

  // Merge typeMetadata with defaults for the expected type
  const defaults = TYPE_METADATA_DEFAULTS[expectedType] || {};
  const rawMetadata = typeof parsed.typeMetadata === 'object' && parsed.typeMetadata !== null
    ? parsed.typeMetadata as Record<string, unknown>
    : {};
  const typeMetadata = { ...defaults, ...rawMetadata };

  logger.debug({ type: expectedType, keywords: keywords.length }, 'Type classification parsed');

  return {
    title,
    type: expectedType,
    category: expectedType, // backward compat
    subcategories,
    summary,
    keywords,
    actionability,
    qualitySignal,
    language,
    typeMetadata,
  };
}

// --- Legacy parser (kept for fallback) ---

/** @deprecated Use parseTypeClassification instead */
export function parseClassification(raw: string): Classification {
  const parsed = extractJson(raw);

  const category = typeof parsed.category === 'string' && VALID_CATEGORIES.has(parsed.category)
    ? parsed.category
    : 'other';

  const subcategories = Array.isArray(parsed.subcategories)
    ? parsed.subcategories.filter((s): s is string => typeof s === 'string').slice(0, 3)
    : [];

  const summary = typeof parsed.summary === 'string'
    ? parsed.summary
    : 'No summary available.';

  const keywords = Array.isArray(parsed.keywords)
    ? parsed.keywords.filter((k): k is string => typeof k === 'string').slice(0, 10)
    : [];

  const actionability = typeof parsed.actionability === 'string' && VALID_ACTIONABILITY.has(parsed.actionability)
    ? parsed.actionability as Classification['actionability']
    : 'reference';

  const qualitySignal = typeof parsed.qualitySignal === 'string' && VALID_QUALITY.has(parsed.qualitySignal)
    ? parsed.qualitySignal as Classification['qualitySignal']
    : 'standard';

  const language = typeof parsed.language === 'string' ? parsed.language : undefined;

  const title = typeof parsed.title === 'string' && parsed.title.length > 0
    ? parsed.title
    : undefined;

  logger.debug({ category, keywords: keywords.length }, 'Classification parsed');

  return { title, category, subcategories, summary, keywords, actionability, qualitySignal, language };
}
