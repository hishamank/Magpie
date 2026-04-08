export const CONTENT_TYPES = [
  'guide', 'article', 'news', 'paper', 'reference', 'tool',
  'list', 'social-post', 'media', 'recipe', 'book',
  'location', 'course', 'other',
] as const;

export type ContentType = typeof CONTENT_TYPES[number];

export const CONTENT_TYPE_SET = new Set<string>(CONTENT_TYPES);

export interface TypeDetectionResult {
  type: ContentType;
}

export interface TypeSpecificClassification {
  title: string;
  type: ContentType;
  category: string;
  subcategories: string[];
  summary: string;
  keywords: string[];
  actionability: 'reference' | 'to-read' | 'to-watch' | 'to-try' | 'to-buy';
  qualitySignal: 'quick-tip' | 'standard' | 'deep-dive' | 'comprehensive';
  language?: string;
  typeMetadata: Record<string, unknown>;
}

/** Default metadata shapes per type — used to fill missing fields */
export const TYPE_METADATA_DEFAULTS: Record<ContentType, Record<string, unknown>> = {
  guide:        { steps: null, prerequisites: [], difficulty: null, estimatedTime: null },
  article:      { thesis: null, perspective: null, depth: null },
  news:         { event: null, date: null, entities: [], impact: null },
  paper:        { authors: [], abstract: null, methodology: null, findings: null },
  reference:    { scope: null, format: null, lastUpdated: null },
  tool:         { solves: null, language: null, platform: null, license: null, alternatives: [] },
  list:         { itemCount: null, listType: null, itemCategory: null },
  'social-post': { author: null, platform: null, engagement: null, threadLength: null },
  media:        { mediaType: null, duration: null, creator: null, series: null },
  recipe:       { cuisine: null, servings: null, prepTime: null, cookTime: null, dietaryTags: [] },
  book:         { bookAuthor: null, genre: null, pages: null, themes: [] },
  location:     { locationType: null, address: null, activities: [], season: null },
  course:       { instructor: null, duration: null, level: null, platform: null, topics: [] },
  other:        {},
};
