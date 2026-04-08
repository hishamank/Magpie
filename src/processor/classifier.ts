import { chatCompletion, getStep2Chain } from '../llm/client.js';
import { buildTypeDetectionPrompt } from '../llm/prompts/type-detection.js';
import { buildTypePrompt } from '../llm/prompts/type-prompts.js';
import { parseTypeDetection, parseTypeClassification } from '../llm/parser.js';
import type { ContentType, TypeSpecificClassification } from '../llm/types.js';
import type { ExtractedContent } from '../extractors/types.js';
import type { BookmarkInput } from '../collectors/types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('classifier');

// Backward-compatible alias
export type Classification = TypeSpecificClassification;

/**
 * Two-step content classification:
 * 1. Detect content type (local model, fast)
 * 2. Type-specific extraction (provider chain, detailed)
 */
export async function classifyContent(
  content: ExtractedContent,
  input: BookmarkInput,
): Promise<TypeSpecificClassification> {
  // Step 1: Type detection (always local)
  const startStep1 = Date.now();
  const type = await detectType(content, input);
  const step1Ms = Date.now() - startStep1;
  logger.info({ url: input.url, type, durationMs: step1Ms, provider: 'local' }, 'Step 1: type detected');

  // Step 2: Type-specific classification (provider chain)
  const startStep2 = Date.now();
  try {
    const chain = getStep2Chain();
    const result = await classifyByType(type, content, input, chain);
    const step2Ms = Date.now() - startStep2;
    logger.info({
      url: input.url,
      type,
      provider: chain.lastUsedProvider,
      durationMs: step2Ms,
      keywordsCount: result.keywords.length,
    }, 'Step 2: type-specific classification complete');
    return result;
  } catch (err) {
    const step2Ms = Date.now() - startStep2;
    logger.warn({ url: input.url, type, durationMs: step2Ms, err }, 'Step 2 failed, using fallback');
    return fallbackClassification(type, content, input);
  }
}

/**
 * Step 1: Detect content type using local model.
 */
async function detectType(
  content: ExtractedContent,
  input: BookmarkInput,
): Promise<ContentType> {
  const prompt = buildTypeDetectionPrompt(content, input);

  let raw: string;
  try {
    raw = await chatCompletion(prompt, { format: 'json', temperature: 0.2 });
  } catch (err) {
    logger.error({ err }, 'Type detection LLM call failed');
    return 'other';
  }

  try {
    const result = parseTypeDetection(raw);
    return result.type;
  } catch (err) {
    // Retry with stricter instruction
    logger.warn({ err }, 'Type detection parse failed, retrying');
    try {
      const retryRaw = await chatCompletion(
        prompt + '\n\nIMPORTANT: Return ONLY { "type": "..." } — nothing else.',
        { format: 'json', temperature: 0.1 },
      );
      return parseTypeDetection(retryRaw).type;
    } catch {
      return 'other';
    }
  }
}

/**
 * Step 2: Type-specific classification using provider chain.
 */
async function classifyByType(
  type: ContentType,
  content: ExtractedContent,
  input: BookmarkInput,
  chain: ReturnType<typeof getStep2Chain>,
): Promise<TypeSpecificClassification> {
  const prompt = buildTypePrompt(type, content, input);

  const raw = await chain.complete(prompt, { format: 'json', temperature: 0.3 });

  try {
    return parseTypeClassification(raw, type);
  } catch (err) {
    // Retry with stricter instruction
    logger.warn({ err }, 'Type classification parse failed, retrying');
    const retryRaw = await chain.complete(
      prompt + '\n\nIMPORTANT: Return ONLY a valid JSON object. No markdown, no explanation, no code fences.',
      { format: 'json', temperature: 0.1 },
    );
    return parseTypeClassification(retryRaw, type);
  }
}

/**
 * Fallback: minimal classification using just the detected type.
 * Used when step 2 fails entirely.
 */
function fallbackClassification(
  type: ContentType,
  content: ExtractedContent,
  input: BookmarkInput,
): TypeSpecificClassification {
  logger.warn({ type, url: input.url }, 'Using fallback classification');

  return {
    title: content.title || input.title || '',
    type,
    category: type,
    subcategories: [],
    summary: `${type} content from ${input.source}. Automatic classification failed — manual review recommended.`,
    keywords: [],
    actionability: 'reference',
    qualitySignal: 'standard',
    typeMetadata: {},
  };
}
