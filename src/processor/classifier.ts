import { chatCompletion } from '../llm/client.js';
import { buildClassificationPrompt } from '../llm/prompts.js';
import { parseClassification, type Classification } from '../llm/parser.js';
import type { ExtractedContent } from '../extractors/types.js';
import type { BookmarkInput } from '../collectors/types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('classifier');

export type { Classification };

export async function classifyContent(
  content: ExtractedContent,
  input: BookmarkInput,
): Promise<Classification> {
  const prompt = buildClassificationPrompt(content, input);

  logger.info({ url: input.url }, 'Classifying content with LLM');

  let raw: string;
  try {
    raw = await chatCompletion(prompt, { format: 'json', temperature: 0.3 });
  } catch (err) {
    logger.error({ err }, 'LLM classification failed');
    throw new Error(`LLM classification failed: ${(err as Error).message}`);
  }

  try {
    return parseClassification(raw);
  } catch (err) {
    // Retry once with stricter prompt
    logger.warn({ err }, 'Classification parse failed, retrying');
    const retryPrompt = prompt + '\n\nIMPORTANT: Return ONLY a valid JSON object. No markdown, no explanation, no code fences.';
    const retryRaw = await chatCompletion(retryPrompt, { format: 'json', temperature: 0.1 });
    return parseClassification(retryRaw);
  }
}
