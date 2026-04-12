import { chatCompletion } from '../llm/client.js';
import { buildSkipGatePrompt, parseSkipGateResult, type SkipGateDecision } from '../llm/prompts/skip-gate.js';
import type { ExtractedContent } from '../extractors/types.js';
import type { BookmarkInput } from '../collectors/types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('skip-gate');

const GATE_TIMEOUT_MS = 30_000;

export type SkipReason = 'music_video';

export type SkipGateResult =
  | { skip: false }
  | { skip: true; reason: SkipReason };

/**
 * Lightweight pre-classifier. Decides whether to skip the full processing pipeline.
 *
 * Fail-open: any LLM error, parse failure, or timeout returns { skip: false } so
 * the normal pipeline handles the bookmark. Silently skipping a non-music URL
 * would be worse than over-processing a music one.
 */
export async function checkSkipGate(
  content: ExtractedContent,
  input: BookmarkInput,
): Promise<SkipGateResult> {
  let prompt: string;
  try {
    prompt = buildSkipGatePrompt(content, input);
  } catch (err) {
    logger.warn({ url: input.url, err: (err as Error).message }, 'skip-gate prompt build failed — continuing normal pipeline');
    return { skip: false };
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let raw: string;
  try {
    raw = await Promise.race([
      chatCompletion(prompt, { format: 'json', temperature: 0.1, reasoningBudget: 0 }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`skip-gate timeout after ${GATE_TIMEOUT_MS}ms`)),
          GATE_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    logger.warn({ url: input.url, err: (err as Error).message }, 'skip-gate LLM call failed — continuing normal pipeline');
    return { skip: false };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  let decision: SkipGateDecision;
  try {
    decision = parseSkipGateResult(raw);
  } catch (err) {
    logger.warn({ url: input.url, err: (err as Error).message, raw: raw.slice(0, 200) }, 'skip-gate parse failed — continuing normal pipeline');
    return { skip: false };
  }

  if (decision.isMusicVideo) {
    logger.info({ url: input.url, reason: decision.reason }, 'skip-gate: music_video — skipping full pipeline');
    return { skip: true, reason: 'music_video' };
  }

  logger.debug({ url: input.url, reason: decision.reason }, 'skip-gate: not music, continuing');
  return { skip: false };
}
