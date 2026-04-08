import { config } from '../config.js';
import { OpenAICompatibleProvider, GeminiCLIProvider } from './providers.js';
import type { LLMProvider } from './providers.js';
import { ProviderChain } from './provider-chain.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('llm');

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

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
      // Gemini uses CLI subprocess instead of HTTP API
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
 * Vision-capable chat completion using the local LLM server.
 * Sends an image alongside a text prompt using multimodal content format.
 */
export async function visionCompletion(
  prompt: string,
  imageBase64: string,
  mimeType: string,
  options?: { temperature?: number }
): Promise<string> {
  const url = `${config.llm.url}/v1/chat/completions`;

  logger.debug('Sending LLM vision request');

  const content: ContentPart[] = [
    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
    { type: 'text', text: prompt },
  ];

  const body: Record<string, unknown> = {
    messages: [{ role: 'user', content }],
    temperature: options?.temperature ?? 0.2,
    stream: false,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM vision API error (${response.status}): ${text}`);
  }

  const data = await response.json() as {
    choices: { message: { content: string } }[];
  };

  logger.debug('LLM vision response received');
  return data.choices[0].message.content;
}
