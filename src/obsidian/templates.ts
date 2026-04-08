import type { BookmarkRow, MediaAttachmentRow } from '../db/queries.js';
import type { EnrichmentResult } from '../processor/enricher.js';

/**
 * Clean extracted content for display in Obsidian notes.
 * Strips HTML artifacts, normalizes whitespace, removes boilerplate noise.
 */
function cleanContentForDisplay(text: string): string {
  return text
    // Remove raw HTML tags
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(div|span|p|section|nav|footer|header|aside|figure|figcaption)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    // Fix emoji shortcodes left as :name:
    .replace(/:(\w+):/g, '')
    // Remove [Music], [Applause] and similar transcription artifacts
    .replace(/\[(?:Music|Applause|Laughter|Inaudible)\]/gi, '')
    // Normalize excessive whitespace
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

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
  lines.push('---');
  lines.push('');

  // Thumbnail
  if (bookmark.thumbnail) {
    lines.push(`![](${bookmark.thumbnail})`);
    lines.push('');
  }

  // Summary — skip fallback/placeholder text
  const isFallbackSummary = bookmark.summary?.includes('Automatic classification failed')
    || bookmark.summary?.includes('manual review recommended');
  if (bookmark.summary && !isFallbackSummary) {
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

  // Key content — formatted per type, cleaned for display
  const rawContent = bookmark.extracted_text;
  if (rawContent) {
    const cleaned = cleanContentForDisplay(rawContent);
    const formatted = formatContentByType(bookmark.content_type, cleaned, bookmark);
    lines.push('## Key Content');
    lines.push('');
    lines.push(formatted);
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
 * Format extracted content based on content type.
 * Each type gets appropriate markdown structure.
 */
function formatContentByType(type: string | null, content: string, bookmark: BookmarkRow): string {
  switch (type) {
    case 'recipe':
      return formatRecipeContent(content);
    case 'list':
      return formatListContent(content);
    case 'guide':
      return formatGuideContent(content);
    case 'media':
      return formatMediaContent(content, bookmark);
    case 'social-post':
      return formatSocialContent(content, bookmark);
    case 'tool':
      return formatToolContent(content, bookmark);
    default:
      // Article, news, paper, reference, course, book, other — content is usually
      // already well-structured markdown from extraction. Just add paragraph breaks
      // to wall-of-text transcriptions.
      return addStructureToWallOfText(content);
  }
}

/**
 * If content is a wall of text (no headings, no line breaks), add paragraph breaks
 * at sentence boundaries approximately every 200 words.
 */
function addStructureToWallOfText(content: string): string {
  // If content already has markdown structure (headings, lists, paragraphs), return as-is
  const hasStructure = /^#{1,3}\s/m.test(content) || content.includes('\n\n') || /^[-*]\s/m.test(content);
  if (hasStructure) return content;

  // Split into sentences and group into paragraphs
  const sentences = content.split(/(?<=[.!?])\s+/);
  if (sentences.length < 5) return content;

  const paragraphs: string[] = [];
  let current: string[] = [];
  let wordCount = 0;

  for (const sentence of sentences) {
    current.push(sentence);
    wordCount += sentence.split(/\s+/).length;
    if (wordCount >= 150) {
      paragraphs.push(current.join(' '));
      current = [];
      wordCount = 0;
    }
  }
  if (current.length > 0) {
    paragraphs.push(current.join(' '));
  }

  return paragraphs.join('\n\n');
}

/**
 * Format recipe content with clear ingredient/step structure.
 */
function formatRecipeContent(content: string): string {
  // If already has recipe structure (ingredients header, numbered steps), return as-is
  if (/ingredients/i.test(content) && (/\d+\.\s/m.test(content) || /^[-*]\s/m.test(content))) {
    return content;
  }

  // Try to split into ingredients and instructions from raw text
  const lines = content.split('\n').filter(l => l.trim());
  const output: string[] = [];
  let inIngredients = false;
  let inSteps = false;

  for (const line of lines) {
    const lower = line.toLowerCase().trim();
    if (/^(ingredients|what you.?ll need)/i.test(lower)) {
      output.push('\n### Ingredients\n');
      inIngredients = true;
      inSteps = false;
      continue;
    }
    if (/^(instructions|directions|steps|method|preparation|how to)/i.test(lower)) {
      output.push('\n### Instructions\n');
      inIngredients = false;
      inSteps = true;
      continue;
    }

    if (inIngredients) {
      const cleaned = line.trim().replace(/^[-•*]\s*/, '');
      if (cleaned) output.push(`- ${cleaned}`);
    } else if (inSteps) {
      const cleaned = line.trim().replace(/^\d+[.)]\s*/, '');
      if (cleaned) output.push(`${cleaned}\n`);
    } else {
      output.push(line);
    }
  }

  return output.length > 0 ? output.join('\n') : addStructureToWallOfText(content);
}

/**
 * Format list content as proper bullet points.
 */
function formatListContent(content: string): string {
  // If already has list structure, return as-is
  if (/^[-*]\s/m.test(content) || /^\d+[.)]\s/m.test(content)) {
    return content;
  }

  // Try to extract list items from the text
  const lines = content.split('\n').filter(l => l.trim());
  const output: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Lines that look like list items (start with number, dash, bullet, or short phrases)
    if (/^\d+[.):]\s*/.test(trimmed)) {
      output.push(`- ${trimmed.replace(/^\d+[.):]\s*/, '')}`);
    } else if (/^[-•*]\s/.test(trimmed)) {
      output.push(trimmed.replace(/^[-•*]\s/, '- '));
    } else if (trimmed.length < 200 && !trimmed.endsWith('.')) {
      // Short lines without periods are likely list items
      output.push(`- ${trimmed}`);
    } else {
      output.push(trimmed);
    }
  }

  return output.join('\n');
}

/**
 * Format guide/tutorial content with section structure.
 */
function formatGuideContent(content: string): string {
  // If already has heading structure, return as-is
  if (/^#{1,3}\s/m.test(content)) return content;

  // Try to detect numbered steps and convert to sections
  const lines = content.split('\n');
  const output: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Convert "Step N:" or "N." at the start of a paragraph to a heading
    const stepMatch = trimmed.match(/^(?:step\s+)?(\d+)[.:)\s]+(.+)/i);
    if (stepMatch && trimmed.length < 200) {
      output.push(`\n### Step ${stepMatch[1]}: ${stepMatch[2]}\n`);
    } else {
      output.push(line);
    }
  }

  const result = output.join('\n');
  // If we didn't add any structure, fall back to paragraph splitting
  return /^###\s/m.test(result) ? result : addStructureToWallOfText(content);
}

/**
 * Format media content (music, video, podcast) with metadata focus.
 */
function formatMediaContent(content: string, bookmark: BookmarkRow): string {
  // For music/songs — the transcription IS the content, just clean it up
  // For videos — the transcript should be the focus, with metadata at top
  const structured = addStructureToWallOfText(content);

  // If content is very short (just a video description), return as-is
  if (structured.length < 500) return structured;

  return structured;
}

/**
 * Format social media content (tweets, threads).
 */
function formatSocialContent(content: string, bookmark: BookmarkRow): string {
  // Social content is usually already formatted (tweet text, thread structure)
  // Just ensure it has proper markdown structure
  return addStructureToWallOfText(content);
}

/**
 * Format tool/repo content with README structure.
 */
function formatToolContent(content: string, bookmark: BookmarkRow): string {
  // GitHub READMEs are already markdown — return as-is
  if (/^#{1,3}\s/m.test(content)) return content;
  return addStructureToWallOfText(content);
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
