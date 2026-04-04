import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { Extractor, ExtractedContent } from './types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('extractor:fallback');

let browserInstance: import('playwright').Browser | null = null;

async function getBrowser(): Promise<import('playwright').Browser> {
  if (!browserInstance) {
    const { chromium } = await import('playwright');
    browserInstance = await chromium.launch({ headless: true });
  }
  return browserInstance;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

export class FallbackExtractor implements Extractor {
  async extract(url: string, _sourceMetadata?: Record<string, unknown>): Promise<ExtractedContent> {
    logger.info({ url }, 'Fallback extraction with Playwright');

    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      const html = await page.content();

      const { document } = parseHTML(html);
      Object.defineProperty(document, 'baseURI', { value: url });

      const reader = new Readability(document as unknown as Document, { charThreshold: 50 });
      const article = reader.parse();

      if (!article) {
        // Last resort: just get the text content of the body
        const bodyText = await page.evaluate(() => document.body.innerText);
        return {
          title: await page.title(),
          text: bodyText.replace(/\n{3,}/g, '\n\n').trim(),
        };
      }

      const text = (article.textContent || '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+/g, ' ')
        .trim();

      return {
        title: article.title || await page.title(),
        text,
        html: article.content || undefined,
        author: article.byline || undefined,
      };
    } finally {
      await page.close();
    }
  }
}
