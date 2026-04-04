import { config } from '../config.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('llm');

export async function chatCompletion(
  prompt: string,
  options?: { temperature?: number; format?: 'json' }
): Promise<string> {
  const url = `${config.ollama.url}/api/chat`;

  logger.debug({ model: config.ollama.model }, 'Sending LLM request');

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollama.model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      format: options?.format,
      options: {
        temperature: options?.temperature ?? 0.3,
        num_ctx: 8192,
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama API error (${response.status}): ${text}`);
  }

  const data = await response.json() as { message: { content: string } };
  logger.debug('LLM response received');
  return data.message.content;
}
