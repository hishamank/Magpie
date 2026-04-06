import { chatCompletion } from '../llm/client.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('extractor:cleanup');

/**
 * Run extracted markdown through the LLM for cleanup.
 * Removes boilerplate, fixes formatting, normalizes heading hierarchy.
 * Returns cleaned markdown, or original if LLM fails or produces suspect output.
 *
 * Only applied to default/medium extractors — API-based extractors already produce clean output.
 */
export async function cleanupMarkdown(
  markdown: string,
  title: string,
  url: string,
): Promise<string> {
  // Skip short content — cleanup isn't worth the LLM call
  if (markdown.length < 500) return markdown;

  // For very long content, only clean the edges (boilerplate clusters at start/end)
  let contentToClean = markdown;
  let isPartial = false;
  if (markdown.length > 4000) {
    const head = markdown.slice(0, 2000);
    const tail = markdown.slice(-1500);
    contentToClean = head + '\n\n[...MIDDLE SECTION OMITTED...]\n\n' + tail;
    isPartial = true;
  }

  const prompt = `You are a content formatter. Clean up the following markdown extracted from a web page. Your job is to PRESERVE all substantive content while removing web boilerplate and fixing formatting.

RULES:
1. REMOVE: cookie notices, newsletter signup CTAs, social sharing buttons text, "Read more" links, author bios that aren't part of the article, navigation remnants, "Related articles" sections, ad text
2. FIX: heading hierarchy should start at ## (# is reserved for the note title), normalize list formatting, fix broken markdown syntax
3. REMOVE duplicate paragraphs (sometimes extractors capture the same content twice)
4. PRESERVE: ALL substantive content — do NOT summarize, condense, or remove meaningful paragraphs
5. PRESERVE: code blocks, images, links, tables, blockquotes
6. Return ONLY the cleaned markdown. No explanation, no wrapping.

Page title: ${title}
URL: ${url}
${isPartial ? '\nNOTE: Only the beginning and end of the content is shown. Clean what you see, preserving the [MIDDLE SECTION OMITTED] marker.\n' : ''}
---
${contentToClean}
---`;

  try {
    const cleaned = await chatCompletion(prompt, { temperature: 0.1 });

    // Safety guard: if LLM output is suspiciously short, keep original
    const minLength = markdown.length * 0.5;
    if (cleaned.length < minLength) {
      logger.warn(
        { url, originalLen: markdown.length, cleanedLen: cleaned.length },
        'LLM cleanup removed too much content, keeping original',
      );
      return markdown;
    }

    // If we only cleaned edges, splice back the middle
    if (isPartial) {
      const markerIndex = cleaned.indexOf('[...MIDDLE SECTION OMITTED...]');
      if (markerIndex !== -1) {
        const cleanedHead = cleaned.slice(0, markerIndex).trimEnd();
        const cleanedTail = cleaned.slice(markerIndex + '[...MIDDLE SECTION OMITTED...]'.length).trimStart();
        const middleStart = 2000;
        const middleEnd = markdown.length - 1500;
        const middle = markdown.slice(middleStart, middleEnd);
        return cleanedHead + '\n\n' + middle + '\n\n' + cleanedTail;
      }
      // Marker not preserved — fall back to original
      return markdown;
    }

    logger.debug(
      { url, originalLen: markdown.length, cleanedLen: cleaned.length },
      'Markdown cleanup complete',
    );
    return cleaned;
  } catch (err) {
    logger.warn({ url, error: (err as Error).message }, 'LLM cleanup failed, keeping original');
    return markdown;
  }
}
