import { chatCompletion } from '../llm/client.js';
import { getBookmarkById, getRelatedBookmarks } from '../db/queries.js';
import { buildNoteName } from '../obsidian/templates.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('enricher');

export interface EnrichedRelation {
  bookmarkId: number;
  noteName: string;
  title: string;
  relationship: string;  // One-sentence description of how they're related
}

export interface EnrichmentResult {
  enrichedSummary: string;    // Summary with natural [[wikilinks]] embedded
  relations: EnrichedRelation[];
}

/**
 * After classification, ask the LLM to describe relationships with
 * the top related bookmarks and embed natural wikilinks in the summary.
 *
 * Returns null if there are no related bookmarks to enrich against.
 */
export async function enrichRelationships(
  bookmarkId: number,
  summary: string,
  title: string,
  category: string,
  keywords: string[],
): Promise<EnrichmentResult | null> {
  const related = getRelatedBookmarks(bookmarkId, 5);

  // Need at least 1 related bookmark to enrich
  if (related.length === 0) {
    return null;
  }

  // Build context about each related bookmark
  interface RelatedCtx {
    index: number;
    id: number;
    noteName: string;
    title: string;
    category: string;
    summary: string;
    sharedKeywords: string[];
  }

  const relatedContext: RelatedCtx[] = [];
  for (let i = 0; i < related.length; i++) {
    const rel = related[i];
    const bookmark = getBookmarkById(rel.id);
    if (!bookmark) continue;

    const noteName = buildNoteName(bookmark);
    const sharedKws = JSON.parse(rel.shared_keywords) as string[];

    relatedContext.push({
      index: i + 1,
      id: rel.id,
      noteName,
      title: bookmark.title || 'Untitled',
      category: bookmark.category || 'other',
      summary: bookmark.summary || '',
      sharedKeywords: sharedKws,
    });
  }

  if (relatedContext.length === 0) return null;

  const relatedBlock = relatedContext.map(r =>
    `[${r.index}] "${r.title}" (${r.category}) — ${r.summary.slice(0, 150)}\n    Note: [[${r.noteName}]] | Shared keywords: ${r.sharedKeywords.join(', ')}`
  ).join('\n');

  const prompt = `You are a knowledge base curator. Given a new bookmark and its most related existing bookmarks, do two things:

1. For each related bookmark, write ONE sentence describing the specific relationship (e.g. "implements the technique from...", "is a newer alternative to...", "contradicts the claim in...", "provides the practical guide for the theory in...").

2. Rewrite the summary below to naturally embed [[wikilinks]] to the related notes where relevant. Use the exact note names provided in double brackets. Only link where the connection is meaningful — don't force links.

NEW BOOKMARK:
Title: ${title}
Category: ${category}
Keywords: ${keywords.join(', ')}
Summary: ${summary}

RELATED BOOKMARKS:
${relatedBlock}

Respond with ONLY valid JSON:
{
  "enrichedSummary": "<the summary rewritten with [[note-name]] wikilinks embedded naturally>",
  "relations": [
    {
      "index": 1,
      "relationship": "<one sentence describing how the new bookmark relates to this one>"
    }
  ]
}`;

  try {
    const raw = await chatCompletion(prompt, { format: 'json', temperature: 0.3 });
    const parsed = parseEnrichmentResponse(raw, relatedContext);
    logger.info({ bookmarkId, relationsCount: parsed.relations.length }, 'Relationships enriched');
    return parsed;
  } catch (err) {
    logger.warn({ bookmarkId, err }, 'Enrichment failed, using basic relationships');
    return null;
  }
}

function parseEnrichmentResponse(
  raw: string,
  relatedContext: readonly { index: number; id: number; noteName: string; title: string }[],
): EnrichmentResult {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in enrichment response');

  let jsonStr = jsonMatch[0];
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

  const parsed = JSON.parse(jsonStr) as {
    enrichedSummary?: string;
    relations?: { index: number; relationship: string }[];
  };

  const enrichedSummary = typeof parsed.enrichedSummary === 'string'
    ? parsed.enrichedSummary
    : '';

  const relations: EnrichedRelation[] = [];
  if (Array.isArray(parsed.relations)) {
    for (const rel of parsed.relations) {
      const ctx = relatedContext.find(r => r.index === rel.index);
      if (ctx && typeof rel.relationship === 'string') {
        relations.push({
          bookmarkId: ctx.id,
          noteName: ctx.noteName,
          title: ctx.title,
          relationship: rel.relationship,
        });
      }
    }
  }

  return { enrichedSummary, relations };
}
