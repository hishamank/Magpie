import { config } from '../config.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('llm');

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export async function chatCompletion(
  prompt: string,
  options?: { temperature?: number; format?: 'json' }
): Promise<string> {
  const url = `${config.llm.url}/v1/chat/completions`;

  logger.debug('Sending LLM request');

  // Strip lone surrogates that crash llama.cpp's JSON parser
  const safePrompt = prompt.replace(/[\uD800-\uDFFF]/g, '');

  const body: Record<string, unknown> = {
    messages: [{ role: 'user', content: safePrompt }],
    temperature: options?.temperature ?? 0.3,
    stream: false,
  };

  if (options?.format === 'json') {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`llama.cpp API error (${response.status}): ${text}`);
  }

  const data = await response.json() as {
    choices: { message: { content: string } }[];
  };

  logger.debug('LLM response received');
  return data.choices[0].message.content;
}

/**
 * Vision-capable chat completion. Sends an image alongside a text prompt
 * using the OpenAI-compatible multimodal content format.
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
