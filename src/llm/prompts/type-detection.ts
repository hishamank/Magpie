import { CONTENT_TYPES } from '../types.js';
import type { ExtractedContent } from '../../extractors/types.js';
import type { BookmarkInput } from '../../collectors/types.js';

/**
 * Build the step 1 prompt: type detection only.
 * Simple task — just pick one type from the list.
 * Sends up to 6000 chars of content for accuracy.
 */
export function buildTypeDetectionPrompt(
  content: ExtractedContent,
  input: BookmarkInput,
): string {
  let contentText = content.markdown || content.text;
  if (contentText.length > 6000) {
    contentText = contentText.slice(0, 4000) + '\n\n[...]\n\n' + contentText.slice(-1500);
  }

  const typeList = CONTENT_TYPES.join(', ');

  return `Classify this bookmark into exactly ONE content type.

Types: ${typeList}

Type definitions:
- guide: tutorials, how-tos, walkthroughs, step-by-step instructions
- article: blog posts, opinion pieces, essays, analysis, deep dives
- news: current events, announcements, press releases, breaking news
- paper: research papers, academic articles, whitepapers
- reference: documentation, API docs, cheatsheets, specs, manuals
- tool: a specific software tool, library, framework, SaaS product, GitHub repo
- list: curated collections, roundups, "awesome" lists, comparisons, "top N" posts
- social-post: tweets, threads, short-form social media posts
- media: music, movies, TV shows, podcasts, videos that are entertainment (not tutorials)
- recipe: cooking recipes, food/drink preparation instructions
- book: book reviews, summaries, reading recommendations
- location: places, travel guides, restaurant reviews, destination recommendations
- course: online courses, workshops, learning paths, educational series
- other: doesn't fit any of the above

Source: ${input.source}
URL: ${input.url}
Title: ${content.title || input.title || 'Unknown'}

Content:
${contentText}

Respond with ONLY valid JSON: { "type": "<one of the types listed above>" }`;
}
