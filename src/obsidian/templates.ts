import type { BookmarkRow } from '../db/queries.js';
import type { EnrichmentResult } from '../processor/enricher.js';

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

export function getCategoryFolder(category: string | null): string {
  const map: Record<string, string> = {
    'tool': 'tools',
    'article': 'articles',
    'guide': 'guides',
    'paper': 'papers',
    'tutorial': 'guides',
    'video-essay': 'videos',
    'repo': 'repos',
    'tweet-thread': 'tweets',
    'recipe': 'recipes',
    'book': 'books',
    'movie': 'movies',
    'trading': 'trading',
    'tip': 'articles',
    'news': 'articles',
    'opinion': 'articles',
    'music': 'entertainment',
    'meme': 'entertainment',
    'entertainment': 'entertainment',
  };
  return map[category || ''] || 'articles';
}

export function buildNoteName(bookmark: BookmarkRow): string {
  const date = (bookmark.collected_at || bookmark.created_at).slice(0, 10);
  const title = slugify(bookmark.title || 'untitled');
  return `${date}-${title}`;
}

export interface NoteContext {
  bookmark: BookmarkRow;
  keywords: { keyword: string; relevance: number }[];
  related: {
    id: number;
    title: string;
    obsidian_path: string | null;
    shared_keywords: string;
    relation_score: number;
  }[];
  enrichment?: EnrichmentResult;
}

export function buildNoteContent(ctx: NoteContext): string {
  const { bookmark, keywords, related, enrichment } = ctx;
  const subcategories = bookmark.subcategories ? JSON.parse(bookmark.subcategories) as string[] : [];
  const tags = keywords.map(k => k.keyword);

  const lines: string[] = [];

  // Frontmatter
  lines.push('---');
  lines.push(`title: "${(bookmark.title || 'Untitled').replace(/"/g, '\\"')}"`);
  lines.push(`url: ${bookmark.url}`);
  lines.push(`source: ${bookmark.source}`);
  lines.push(`category: ${bookmark.category || 'other'}`);

  if (subcategories.length > 0) {
    lines.push('subcategories:');
    for (const sc of subcategories) {
      lines.push(`  - ${sc}`);
    }
  }

  if (tags.length > 0) {
    lines.push('tags:');
    for (const tag of tags) {
      lines.push(`  - ${tag}`);
    }
  }

  if (bookmark.author) lines.push(`author: ${bookmark.author}`);
  lines.push(`actionability: ${bookmark.actionability || 'reference'}`);
  lines.push(`quality: ${bookmark.quality_signal || 'standard'}`);
  lines.push(`collected: ${(bookmark.collected_at || bookmark.created_at).slice(0, 10)}`);
  if (bookmark.processed_at) lines.push(`processed: ${bookmark.processed_at.slice(0, 10)}`);
  if (bookmark.thumbnail) lines.push(`thumbnail: "${bookmark.thumbnail}"`);
  lines.push(`status: ${bookmark.actionability || 'reference'}`);
  lines.push('---');
  lines.push('');

  // Thumbnail
  if (bookmark.thumbnail) {
    lines.push(`![](${bookmark.thumbnail})`);
    lines.push('');
  }

  // Summary
  if (bookmark.summary) {
    lines.push('## Summary');
    lines.push('');
    lines.push(bookmark.summary);
    lines.push('');
  }

  // Key content (full extracted text)
  if (bookmark.extracted_text) {
    lines.push('## Key Content');
    lines.push('');
    lines.push(bookmark.extracted_text);
    lines.push('');
  }

  // Related bookmarks — only include those with existing vault notes
  const validRelated = related.filter(r => r.obsidian_path);

  if (enrichment && enrichment.relations.length > 0) {
    // Filter enrichment relations to only those with vault notes
    const validEnriched = enrichment.relations.filter(r => {
      return validRelated.some(vr => vr.id === r.bookmarkId);
    });

    if (validEnriched.length > 0 || validRelated.length > 0) {
      lines.push('## Related Bookmarks');
      lines.push('');
      for (const rel of validEnriched) {
        lines.push(`- [[${rel.noteName}|${rel.title}]] — ${rel.relationship}`);
      }
      const enrichedIds = new Set(validEnriched.map(r => r.bookmarkId));
      for (const rel of validRelated) {
        if (enrichedIds.has(rel.id)) continue;
        const noteName = rel.obsidian_path!.replace(/\.md$/, '').split('/').pop()!;
        const sharedKws = JSON.parse(rel.shared_keywords) as string[];
        lines.push(`- [[${noteName}]] — shares keywords: ${sharedKws.join(', ')}`);
      }
      lines.push('');
    }
  } else if (validRelated.length > 0) {
    lines.push('## Related Bookmarks');
    lines.push('');
    for (const rel of validRelated) {
      const noteName = rel.obsidian_path!.replace(/\.md$/, '').split('/').pop()!;
      const sharedKws = JSON.parse(rel.shared_keywords) as string[];
      lines.push(`- [[${noteName}]] — shares keywords: ${sharedKws.join(', ')}`);
    }
    lines.push('');
  }

  // Source info
  lines.push('## Source Info');
  lines.push('');
  lines.push(`- **Collected from:** ${bookmark.source}`);
  lines.push(`- **Original URL:** [Link](${bookmark.url})`);
  if (bookmark.raw_content_path) {
    lines.push(`- **Archived:** \`${bookmark.raw_content_path}\``);
  }
  lines.push('');

  return lines.join('\n');
}
