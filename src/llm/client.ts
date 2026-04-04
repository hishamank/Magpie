import { config } from '../config.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('llm');

export async function chatCompletion(
  prompt: string,
  options?: { temperature?: number; format?: 'json' }
): Promise<string> {
  const url = `${config.llm.url}/v1/chat/completions`;

  logger.debug('Sending LLM request');

  const body: Record<string, unknown> = {
    messages: [{ role: 'user', content: prompt }],
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
