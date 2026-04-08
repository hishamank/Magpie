import type { ExtractedContent } from '../../extractors/types.js';
import type { BookmarkInput } from '../../collectors/types.js';

/**
 * @deprecated Use buildTypeDetectionPrompt + buildTypePrompt instead.
 * Kept as fallback for single-call classification.
 */
export function buildClassificationPrompt(
  content: ExtractedContent,
  input: BookmarkInput
): string {
  // Prefer markdown (preserves structure) over plain text
  let contentText = content.markdown || content.text;
  if (contentText.length > 3000) {
    contentText = contentText.slice(0, 2000) + '\n\n[...]\n\n' + contentText.slice(-1000);
  }

  return `You are a bookmark classifier. Analyze the following content and return a JSON object with your classification. Respond with ONLY valid JSON, no explanation, no markdown backticks.

Source: ${input.source}
URL: ${input.url}
Title: ${content.title || 'Unknown'}
Author: ${content.author || 'Unknown'}

Content (first 3000 chars):
${contentText}

Classify this into the following JSON structure:
{
  "title": "<short, descriptive title for this content — NOT the author name or 'Thread by @x', but a real title describing the topic, e.g. '12 Python Libraries for Free Market Data' or 'Building RAG Pipelines with LangChain'>",
  "category": "<one of: tool, article, guide, paper, tutorial, recipe, trading, movie, book, tweet-thread, repo, video-essay, tip, news, opinion, music, meme, entertainment, other>",
  "subcategories": ["<up to 3 more specific subcategories>"],
  "summary": "<2-3 sentence summary of what this content is about and why it's useful>",
  "keywords": ["<5-10 specific, descriptive keywords — not generic words like 'interesting' or 'technology', but specific concepts like 'RAG-pipeline', 'dividend-investing', 'nextjs-middleware', 'home-automation'>"],
  "actionability": "<one of: reference (keep for reference), to-read (should read in full), to-watch (should watch), to-try (should try/build/experiment), to-buy (consider purchasing)>",
  "qualitySignal": "<one of: quick-tip (small nugget of info), standard (typical article/post), deep-dive (thorough exploration), comprehensive (definitive resource on topic)>",
  "language": "<detected language code, e.g. en, ar, es>"
}

Important:
- Keywords should be hyphenated-compound-terms when appropriate (e.g. "react-server-components" not just "react")
- The summary should explain what value this content provides, not just what it's about
- If it's a tool/repo, mention what problem it solves
- If it's a video, base classification on the transcript content
- Be specific with subcategories (e.g. "frontend-performance" not just "web-development")`;
}
