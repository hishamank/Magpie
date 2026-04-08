import type { LLMProvider, CompletionOptions } from './providers.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('llm:chain');

/**
 * Tries multiple LLM providers in order.
 * Falls through on errors and rate limits (429).
 * Throws an aggregated error only if ALL providers fail.
 */
export class ProviderChain {
  private providers: LLMProvider[];
  lastUsedProvider?: string;

  constructor(providers: LLMProvider[]) {
    if (providers.length === 0) {
      throw new Error('ProviderChain requires at least one provider');
    }
    this.providers = providers;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const errors: { provider: string; error: string }[] = [];

    for (const provider of this.providers) {
      try {
        const result = await provider.complete(prompt, options);
        this.lastUsedProvider = provider.name;
        return result;
      } catch (err) {
        const message = (err as Error).message || '';
        const statusCode = (err as Record<string, unknown>).statusCode as number | undefined;

        errors.push({ provider: provider.name, error: message });

        // 429 = rate limited — try next provider
        if (statusCode === 429) {
          logger.warn({ provider: provider.name }, 'Rate limited, trying next provider');
          continue;
        }

        // Other errors — also try next provider
        logger.warn({ provider: provider.name, error: message }, 'Provider failed, trying next');
      }
    }

    const summary = errors.map(e => `${e.provider}: ${e.error}`).join('; ');
    throw new Error(`All LLM providers failed: ${summary}`);
  }
}
