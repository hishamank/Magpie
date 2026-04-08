import { runCommand } from '../utils/subprocess.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('llm:provider');

export interface CompletionOptions {
  temperature?: number;
  format?: 'json';
  timeoutMs?: number;
}

export interface LLMProvider {
  name: string;
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
}

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model?: string;
}

/**
 * Generic OpenAI-compatible provider.
 * Works with llama.cpp, OpenRouter, Groq, Nvidia, Gemini, and any other
 * provider that implements the /v1/chat/completions endpoint.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private baseUrl: string;
  private apiKey?: string;
  private model?: string;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;

    // Strip lone surrogates (crashes llama.cpp, harmless for cloud providers)
    const safePrompt = prompt.replace(/[\uD800-\uDFFF]/g, '');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: safePrompt }],
      temperature: options?.temperature ?? 0.3,
      stream: false,
    };

    // Only include model for cloud providers (llama.cpp serves one model)
    if (this.model) {
      body.model = this.model;
    }

    if (options?.format === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const timeout = options?.timeoutMs ?? 120_000;

    logger.debug({ provider: this.name, model: this.model }, 'Sending LLM request');

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      const text = await response.text();
      const err = new Error(`${this.name} API error (${response.status}): ${text}`);
      (err as unknown as Record<string, unknown>).statusCode = response.status;
      throw err;
    }

    const data = await response.json() as {
      choices: { message: { content: string } }[];
    };

    logger.debug({ provider: this.name }, 'LLM response received');
    return data.choices[0].message.content;
  }
}

/**
 * Provider that uses the gemini-cli (`gemini` command) as a subprocess.
 * Uses `-p` for non-interactive mode and `-o json` to parse the response.
 * Authenticated via the CLI's own credential cache (gcloud/OAuth).
 */
export class GeminiCLIProvider implements LLMProvider {
  readonly name = 'gemini-cli';
  private model?: string;

  constructor(model?: string) {
    this.model = model;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const timeout = options?.timeoutMs ?? 120_000;

    const args = ['-p', prompt, '-o', 'json'];
    if (this.model) {
      args.push('-m', this.model);
    }

    logger.debug({ provider: this.name, model: this.model }, 'Sending gemini-cli request');

    const { stdout } = await runCommand('gemini', args, { timeout });

    // gemini-cli JSON output: { "response": "...", "stats": {...} }
    try {
      const data = JSON.parse(stdout) as { response: string };
      logger.debug({ provider: this.name }, 'gemini-cli response received');
      return data.response;
    } catch {
      // If JSON parse fails, the raw stdout might be the response (text mode fallback)
      const trimmed = stdout.trim();
      if (trimmed.length > 0) return trimmed;
      throw new Error('gemini-cli returned empty response');
    }
  }
}
