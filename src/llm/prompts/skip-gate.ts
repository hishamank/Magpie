import type { ExtractedContent } from '../../extractors/types.js';
import type { BookmarkInput } from '../../collectors/types.js';

export interface SkipGateDecision {
  isMusicVideo: boolean;
  reason: string;
}

/**
 * Build the skip-gate prompt. Metadata-only — no transcript, no article body.
 * Target: very short prompt, cheap completion.
 */
export function buildSkipGatePrompt(
  content: ExtractedContent,
  input: BookmarkInput,
): string {
  const title = content.title || input.title || 'Unknown';
  const author = content.author || '';
  const description = typeof content.metadata?.description === 'string'
    ? (content.metadata.description as string).slice(0, 500)
    : '';
  const categories = Array.isArray(content.metadata?.categories)
    ? (content.metadata.categories as string[]).join(', ')
    : '';
  const tags = Array.isArray(content.metadata?.tags)
    ? (content.metadata.tags as string[]).slice(0, 10).join(', ')
    : '';

  return `Decide if this bookmark is a MUSIC VIDEO, SONG, or other musical audio/video entertainment.

Return true (isMusicVideo=true) for:
- Official music videos
- Songs, singles, albums, EPs
- Official audio uploads
- Live performances of songs
- Lyric videos
- DJ sets, mixes, remixes
- Hip-hop freestyles over beats

Return false (isMusicVideo=false) for:
- Podcasts, interviews, talk shows
- Tutorials, how-tos, lectures, conference talks
- News clips, commentary, reviews
- Video essays, documentaries
- Vlogs, Q&A, reaction videos
- Music *theory* or music *industry* analysis (these are articles ABOUT music, not music itself)

Source: ${input.source}
URL: ${input.url}
Title: ${title}
Channel/Author: ${author}
Platform categories: ${categories}
Platform tags: ${tags}
Description (truncated): ${description}

Respond with ONLY valid JSON: { "isMusicVideo": <true|false>, "reason": "<one sentence>" }`;
}

/**
 * Parse the raw LLM response into a SkipGateDecision.
 * Throws if the response can't be parsed — callers treat that as fail-open (skip=false).
 */
export function parseSkipGateResult(raw: string): SkipGateDecision {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON object in skip-gate response');
  }
  const parsed = JSON.parse(jsonMatch[0].replace(/,\s*([}\]])/g, '$1')) as Record<string, unknown>;

  if (typeof parsed.isMusicVideo !== 'boolean') {
    throw new Error('isMusicVideo missing or non-boolean in skip-gate response');
  }

  const reason = typeof parsed.reason === 'string' && parsed.reason.length > 0
    ? parsed.reason
    : '(no reason provided)';
  return { isMusicVideo: parsed.isMusicVideo, reason };
}
