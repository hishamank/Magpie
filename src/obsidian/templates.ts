import type { BookmarkRow, MediaAttachmentRow } from '../db/queries.js';
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
    // New 14 types
    'guide': 'guides',
    'article': 'articles',
    'news': 'news',
    'paper': 'papers',
    'reference': 'reference',
    'tool': 'tools',
    'list': 'lists',
    'social-post': 'social',
    'media': 'media',
    'recipe': 'recipes',
    'book': 'books',
    'location': 'locations',
    'course': 'courses',
    'other': 'other',
    // Legacy mappings (for existing bookmarks)
    'tutorial': 'guides',
    'video-essay': 'articles',
    'repo': 'tools',
    'tweet-thread': 'social',
    'movie': 'media',
    'trading': 'articles',
    'tip': 'articles',
    'opinion': 'articles',
    'music': 'media',
    'meme': 'other',
    'entertainment': 'media',
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
  media?: MediaAttachmentRow[];
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
  if (bookmark.content_type) lines.push(`type: ${bookmark.content_type}`);
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

  // Type-specific details
  if (bookmark.type_metadata) {
    try {
      const meta = JSON.parse(bookmark.type_metadata) as Record<string, unknown>;
      const detailLines = renderTypeMetadata(bookmark.content_type, meta);
      if (detailLines.length > 0) {
        lines.push('## Details');
        lines.push('');
        lines.push(...detailLines);
        lines.push('');
      }
    } catch {
      // Invalid JSON — skip
    }
  }

  // Key content — prefer markdown (preserves structure) over plain text
  const keyContent = bookmark.extracted_text;
  if (keyContent) {
    lines.push('## Key Content');
    lines.push('');
    lines.push(keyContent);
    lines.push('');
  }

  // Media section — local downloads with OCR/transcription
  const mediaItems = ctx.media || [];
  const mediaWithFiles = mediaItems.filter(m => m.local_path);
  if (mediaWithFiles.length > 0) {
    const videos = mediaWithFiles.filter(m => m.type === 'video' || m.type === 'audio');
    const imagesWithOcr = mediaWithFiles.filter(m => m.type === 'image' && m.ocr_text);

    if (videos.length > 0 || imagesWithOcr.length > 0) {
      lines.push('## Media');
      lines.push('');

      for (const v of videos) {
        lines.push(`- **${v.type === 'video' ? 'Video' : 'Audio'}:** \`${v.local_path}\``);
        if (v.transcription) {
          lines.push('');
          lines.push('  <details><summary>Transcription</summary>');
          lines.push('');
          lines.push('  ' + v.transcription.replace(/\n/g, '\n  '));
          lines.push('');
          lines.push('  </details>');
        }
      }

      for (const img of imagesWithOcr) {
        lines.push(`- **Image OCR** (\`${img.local_path}\`):`);
        lines.push('');
        lines.push('  > ' + (img.ocr_text || '').replace(/\n/g, '\n  > '));
      }

      lines.push('');
    }
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

/**
 * Render type-specific metadata as markdown bullet points.
 * Returns empty array if no meaningful metadata exists.
 */
function renderTypeMetadata(type: string | null, meta: Record<string, unknown>): string[] {
  const lines: string[] = [];

  function addField(label: string, value: unknown): void {
    if (value === null || value === undefined || value === '') return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      lines.push(`- **${label}:** ${value.join(', ')}`);
    } else {
      lines.push(`- **${label}:** ${value}`);
    }
  }

  switch (type) {
    case 'guide':
      addField('Difficulty', meta.difficulty);
      addField('Prerequisites', meta.prerequisites);
      addField('Steps', meta.steps);
      addField('Estimated time', meta.estimatedTime);
      break;
    case 'article':
      addField('Thesis', meta.thesis);
      addField('Perspective', meta.perspective);
      addField('Depth', meta.depth);
      break;
    case 'news':
      addField('Event', meta.event);
      addField('Date', meta.date);
      addField('Entities', meta.entities);
      addField('Impact', meta.impact);
      break;
    case 'paper':
      addField('Authors', meta.authors);
      addField('Methodology', meta.methodology);
      addField('Findings', meta.findings);
      break;
    case 'reference':
      addField('Scope', meta.scope);
      addField('Format', meta.format);
      break;
    case 'tool':
      addField('Solves', meta.solves);
      addField('Language', meta.language);
      addField('Platform', meta.platform);
      addField('License', meta.license);
      addField('Alternatives', meta.alternatives);
      break;
    case 'list':
      addField('Items', meta.itemCount);
      addField('List type', meta.listType);
      addField('Category', meta.itemCategory);
      break;
    case 'social-post':
      addField('Author', meta.author);
      addField('Platform', meta.platform);
      addField('Engagement', meta.engagement);
      addField('Thread length', meta.threadLength);
      break;
    case 'media':
      addField('Type', meta.mediaType);
      addField('Duration', meta.duration);
      addField('Creator', meta.creator);
      addField('Series', meta.series);
      break;
    case 'recipe':
      addField('Cuisine', meta.cuisine);
      addField('Servings', meta.servings);
      addField('Prep time', meta.prepTime);
      addField('Cook time', meta.cookTime);
      addField('Dietary', meta.dietaryTags);
      break;
    case 'book':
      addField('Author', meta.bookAuthor);
      addField('Genre', meta.genre);
      addField('Pages', meta.pages);
      addField('Themes', meta.themes);
      break;
    case 'location':
      addField('Type', meta.locationType);
      addField('Address', meta.address);
      addField('Activities', meta.activities);
      addField('Best season', meta.season);
      break;
    case 'course':
      addField('Instructor', meta.instructor);
      addField('Duration', meta.duration);
      addField('Level', meta.level);
      addField('Platform', meta.platform);
      addField('Topics', meta.topics);
      break;
  }

  return lines;
}
