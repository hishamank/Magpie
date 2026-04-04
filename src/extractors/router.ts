import type { Extractor, ExtractedContent } from './types.js';
import { ArticleExtractor } from './article.js';
import { TweetExtractor } from './tweet.js';
import { YouTubeExtractor } from './youtube.js';
import { GitHubExtractor } from './github.js';
import { PDFExtractor } from './pdf.js';
import { FallbackExtractor } from './fallback.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('extractor:router');

const articleExtractor = new ArticleExtractor();
const tweetExtractor = new TweetExtractor();
const youtubeExtractor = new YouTubeExtractor();
const githubExtractor = new GitHubExtractor();
const pdfExtractor = new PDFExtractor();
const fallbackExtractor = new FallbackExtractor();

export function getExtractor(url: string): Extractor {
  const domain = new URL(url).hostname.replace('www.', '');

  if (domain === 'twitter.com' || domain === 'x.com') return tweetExtractor;
  if (domain === 'youtube.com' || domain === 'youtu.be') return youtubeExtractor;
  if (domain === 'github.com') return githubExtractor;
  if (url.match(/\.pdf(\?|$)/i)) return pdfExtractor;

  return articleExtractor;
}

/**
 * Extract content with automatic fallback to Playwright for JS-heavy sites.
 */
export async function extractContent(url: string, sourceMetadata?: Record<string, unknown>): Promise<ExtractedContent> {
  const extractor = getExtractor(url);

  try {
    return await extractor.extract(url, sourceMetadata);
  } catch (err) {
    // If the primary extractor fails and it's an article, try fallback
    if (extractor instanceof ArticleExtractor) {
      logger.warn({ url, err }, 'Article extraction failed, trying fallback');
      return fallbackExtractor.extract(url, sourceMetadata);
    }
    throw err;
  }
}
