import { getLogger } from '../utils/logger.js';

const logger = getLogger('llm-parser');

export interface Classification {
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
  'tip', 'news', 'opinion', 'other',
]);

const VALID_ACTIONABILITY = new Set(['reference', 'to-read', 'to-watch', 'to-try', 'to-buy']);
const VALID_QUALITY = new Set(['quick-tip', 'standard', 'deep-dive', 'comprehensive']);

export function parseClassification(raw: string): Classification {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

  // Try to extract JSON from the response
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON object found in LLM response');
  }

  // Fix trailing commas (common LLM mistake)
  let jsonStr = jsonMatch[0];
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Failed to parse JSON: ${(err as Error).message}\nRaw: ${jsonStr.slice(0, 200)}`);
  }

  // Validate and normalize
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

  logger.debug({ category, keywords: keywords.length }, 'Classification parsed');

  return { category, subcategories, summary, keywords, actionability, qualitySignal, language };
}
