import { config } from '../config.js';
import { OpenAICompatibleProvider, GeminiCLIProvider } from './providers.js';
import type { LLMProvider } from './providers.js';
import { ProviderChain } from './provider-chain.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('llm');

// Lazily initialized local provider
let localProvider: OpenAICompatibleProvider | null = null;

function getLocalProvider(): OpenAICompatibleProvider {
  if (!localProvider) {
    localProvider = new OpenAICompatibleProvider({
      name: 'local',
      baseUrl: config.llm.url + '/v1',
    });
  }
  return localProvider;
}

// Lazily initialized step 2 provider chain
let step2Chain: ProviderChain | null = null;

/**
 * Get the provider chain for step 2 classification.
 * Uses configured providers with fallback (default: local only).
 */
export function getStep2Chain(): ProviderChain {
  if (!step2Chain) {
    const providers: LLMProvider[] = config.llm.step2Providers.map(cfg => {
      if (cfg.name === 'gemini') {
        return new GeminiCLIProvider(cfg.model);
      }
      return new OpenAICompatibleProvider({
        name: cfg.name,
        baseUrl: cfg.baseUrl.includes('/v1') ? cfg.baseUrl : cfg.baseUrl + '/v1',
        apiKey: cfg.apiKey,
        model: cfg.model,
      });
    });
    step2Chain = new ProviderChain(providers);
  }
  return step2Chain;
}

// Lazily initialized vision providers
let visionProviders: OpenAICompatibleProvider[] | null = null;

function getVisionProviders(): OpenAICompatibleProvider[] {
  if (!visionProviders) {
    visionProviders = config.llm.visionProviders.map(cfg =>
      new OpenAICompatibleProvider({
        name: cfg.name,
        baseUrl: cfg.baseUrl.includes('/v1') ? cfg.baseUrl : cfg.baseUrl + '/v1',
        apiKey: cfg.apiKey,
        model: cfg.model,
      })
    );
  }
  return visionProviders;
}

/**
 * Chat completion using the local LLM server.
 * Used for step 1 type detection, enrichment, and cleanup.
 */
export async function chatCompletion(
  prompt: string,
  options?: { temperature?: number; format?: 'json' }
): Promise<string> {
  return getLocalProvider().complete(prompt, {
    temperature: options?.temperature,
    format: options?.format,
  });
}

/**
 * Vision-capable chat completion using cloud LLM providers.
 * Tries providers in order (groq → openrouter → nvidia) with fallback.
 */
export async function visionCompletion(
  prompt: string,
  imageBase64: string,
  mimeType: string,
  options?: { temperature?: number }
): Promise<string> {
  const providers = getVisionProviders();

  if (providers.length === 0) {
    throw new Error('No vision providers configured (need GROQ_API_KEY, OPENROUTER_API_KEY, or NVIDIA_API_KEY)');
  }

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    try {
      logger.debug({ provider: provider.name }, 'Sending vision request');
      const result = await provider.visionComplete!(prompt, imageBase64, mimeType, {
        temperature: options?.temperature,
      });
      logger.debug({ provider: provider.name }, 'Vision response received');
      return result;
    } catch (err) {
      const statusCode = (err as unknown as Record<string, unknown>).statusCode as number | undefined;
      logger.warn({ provider: provider.name, statusCode, error: (err as Error).message?.slice(0, 100) }, 'Vision provider failed');
      if (i === providers.length - 1) throw err;
      // Try next provider
    }
  }

  throw new Error('All vision providers failed');
}
