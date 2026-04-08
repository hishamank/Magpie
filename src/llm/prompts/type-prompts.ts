import type { ContentType } from '../types.js';
import type { ExtractedContent } from '../../extractors/types.js';
import type { BookmarkInput } from '../../collectors/types.js';

/**
 * Dispatch to the appropriate type-specific prompt builder.
 */
export function buildTypePrompt(
  type: ContentType,
  content: ExtractedContent,
  input: BookmarkInput,
): string {
  const builder = TYPE_PROMPT_BUILDERS[type] || TYPE_PROMPT_BUILDERS.other;
  return builder(content, input);
}

// --- Shared helpers ---

function trimContent(content: ExtractedContent, maxChars: number = 10000): string {
  let text = content.markdown || content.text;
  if (text.length > maxChars) {
    const head = Math.floor(maxChars * 0.65);
    const tail = Math.floor(maxChars * 0.3);
    text = text.slice(0, head) + '\n\n[...]\n\n' + text.slice(-tail);
  }
  return text;
}

function baseContext(content: ExtractedContent, input: BookmarkInput): string {
  return `Source: ${input.source}
URL: ${input.url}
Title: ${content.title || input.title || 'Unknown'}
Author: ${content.author || 'Unknown'}`;
}

function standardOutputFormat(typeMetadataSpec: string): string {
  return `Respond with ONLY valid JSON:
{
  "title": "<short, descriptive title that captures the core topic>",
  "subcategories": ["<up to 3 specific subcategories>"],
  "summary": "<2-3 sentence summary explaining WHAT this is and WHY it's useful>",
  "keywords": ["<8-12 specific, hyphenated compound terms — not generic words>"],
  "actionability": "<reference | to-read | to-watch | to-try | to-buy>",
  "qualitySignal": "<quick-tip | standard | deep-dive | comprehensive>",
  "language": "<language code, e.g. en, ar, es>",
  "typeMetadata": ${typeMetadataSpec}
}

Keyword guidelines:
- Use hyphenated compound terms: "react-server-components" not just "react"
- Include specific technologies, techniques, concepts mentioned
- Include the problem domain and field
- Avoid generic words like "interesting", "useful", "technology"`;
}

// --- Type-specific prompt builders ---

type PromptBuilder = (content: ExtractedContent, input: BookmarkInput) => string;

const TYPE_PROMPT_BUILDERS: Record<string, PromptBuilder> = {
  guide: (content, input) => `You are classifying a GUIDE/TUTORIAL. This content teaches the reader how to do something.

${baseContext(content, input)}

Content:
${trimContent(content)}

Focus on:
- What skill or task does this teach?
- What tools/technologies are used?
- What's the difficulty level?
- Keywords should include: technique names, tools used, the problem being solved, difficulty-related terms

${standardOutputFormat(`{
    "steps": <number of steps/sections or null>,
    "prerequisites": ["<what the reader needs to know beforehand>"],
    "difficulty": "<beginner | intermediate | advanced | null>",
    "estimatedTime": "<estimated time to complete, e.g. '30 minutes', '2 hours', or null>"
  }`)}`,

  article: (content, input) => `You are classifying an ARTICLE (blog post, opinion piece, essay, analysis).

${baseContext(content, input)}

Content:
${trimContent(content)}

Focus on:
- What's the central thesis or argument?
- What perspective does the author bring?
- Keywords should include: the specific topic, the author's field, key concepts discussed, any frameworks or models mentioned

${standardOutputFormat(`{
    "thesis": "<the main argument or point in one sentence, or null>",
    "perspective": "<the author's angle, e.g. 'critical', 'practical', 'theoretical', or null>",
    "depth": "<surface | moderate | thorough | null>"
  }`)}`,

  news: (content, input) => `You are classifying a NEWS item (event, announcement, press release).

${baseContext(content, input)}

Content:
${trimContent(content)}

Focus on:
- What happened? Who's involved? When?
- What's the impact or significance?
- Keywords should include: the event, key entities (companies, people, technologies), the industry/field affected

${standardOutputFormat(`{
    "event": "<what happened in one sentence>",
    "date": "<when it happened, ISO format if possible, or null>",
    "entities": ["<key people, companies, or organizations involved>"],
    "impact": "<brief description of significance or null>"
  }`)}`,

  paper: (content, input) => `You are classifying a RESEARCH PAPER or academic article.

${baseContext(content, input)}

Content:
${trimContent(content)}

Focus on:
- What research question does it address?
- What methodology was used?
- What are the key findings?
- Keywords should include: the research field, methodology, key findings, specific techniques

${standardOutputFormat(`{
    "authors": ["<paper authors if identifiable>"],
    "abstract": "<one-paragraph abstract or null>",
    "methodology": "<research method used, e.g. 'survey', 'experiment', 'meta-analysis', or null>",
    "findings": "<key findings in one sentence or null>"
  }`)}`,

  reference: (content, input) => `You are classifying REFERENCE material (documentation, API docs, cheatsheet, specs).

${baseContext(content, input)}

Content:
${trimContent(content)}

Focus on:
- What does this document cover?
- Is it a quick reference or comprehensive documentation?
- Keywords should include: the technology/topic documented, the type of reference, specific APIs or features covered

${standardOutputFormat(`{
    "scope": "<what this reference covers, e.g. 'Python asyncio API', 'CSS Grid properties'>",
    "format": "<cheatsheet | api-docs | specification | manual | null>",
    "lastUpdated": "<date if identifiable, or null>"
  }`)}`,

  tool: (content, input) => `You are classifying a SOFTWARE TOOL, library, framework, or GitHub repo.

${baseContext(content, input)}

Content:
${trimContent(content)}

Focus on:
- What problem does this tool solve?
- What language/platform is it for?
- What are the alternatives?
- Keywords should include: the problem domain, programming language, platform, tool category, specific features

${standardOutputFormat(`{
    "solves": "<what problem this tool solves in one sentence>",
    "language": "<primary programming language or null>",
    "platform": "<platform, e.g. 'web', 'mobile', 'CLI', 'cross-platform', or null>",
    "license": "<license type if identifiable, e.g. 'MIT', 'Apache-2.0', or null>",
    "alternatives": ["<known alternatives to this tool>"]
  }`)}`,

  list: (content, input) => `You are classifying a CURATED LIST (collection, roundup, "top N", comparison, "awesome" list).

${baseContext(content, input)}

Content:
${trimContent(content)}

Focus on:
- What is being listed? (tools, recipes, places, books, etc.)
- How many items are in the list?
- Is it ranked, compared, or just collected?
- Keywords should include: what's being listed, the domain, any standout items mentioned, the selection criteria

${standardOutputFormat(`{
    "itemCount": <number of items in the list or null>,
    "listType": "<ranked | unranked | comparison | null>",
    "itemCategory": "<what the items are, e.g. 'JavaScript frameworks', 'Italian recipes', 'travel destinations'>"
  }`)}`,

  'social-post': (content, input) => `You are classifying a SOCIAL MEDIA POST (tweet, thread, short-form post).

${baseContext(content, input)}

Content:
${trimContent(content)}

Focus on:
- What is the core message or insight?
- Is this a thread with a narrative arc or a single post?
- Keywords should include: the specific topic discussed, any tools/concepts mentioned, the author's field/expertise
- The title should describe the TOPIC, not just "Tweet by @user"

${standardOutputFormat(`{
    "author": "<author username or name>",
    "platform": "<twitter | reddit | mastodon | other>",
    "engagement": "<high | moderate | low | null — based on likes/reposts if available>",
    "threadLength": <number of posts in thread or 1>
  }`)}`,

  media: (content, input) => `You are classifying ENTERTAINMENT MEDIA (music, movie, TV show, podcast, non-tutorial video).

${baseContext(content, input)}

Content:
${trimContent(content)}

Focus on:
- What type of media is this? (song, album, film, podcast episode, etc.)
- Who created it?
- What genre?
- Keywords should include: genre, creator/artist, specific series/franchise, mood/themes

${standardOutputFormat(`{
    "mediaType": "<song | album | playlist | film | tv-show | documentary | podcast | video | null>",
    "duration": "<duration if known, e.g. '2h15m', '45 min', or null>",
    "creator": "<artist, director, or creator name>",
    "series": "<series/franchise name if part of one, or null>"
  }`)}`,

  recipe: (content, input) => `You are classifying a RECIPE (cooking/food/drink instructions).

${baseContext(content, input)}

Content:
${trimContent(content)}

Focus on:
- What dish is being made?
- What cuisine is it?
- Keywords should include: the dish name, cuisine type, key ingredients, cooking technique, dietary category

${standardOutputFormat(`{
    "cuisine": "<cuisine type, e.g. 'Italian', 'Japanese', 'Mexican', or null>",
    "servings": <number of servings or null>,
    "prepTime": "<preparation time, e.g. '15 min', or null>",
    "cookTime": "<cooking time, e.g. '1 hour', or null>",
    "dietaryTags": ["<e.g. 'vegetarian', 'gluten-free', 'keto'>"]
  }`)}`,

  book: (content, input) => `You are classifying BOOK-related content (review, summary, recommendation).

${baseContext(content, input)}

Content:
${trimContent(content)}

Focus on:
- What book is this about?
- What are the key ideas or themes?
- Who should read it?
- Keywords should include: the book title, author name, genre, key themes, target audience

${standardOutputFormat(`{
    "bookAuthor": "<the book's author>",
    "genre": "<genre, e.g. 'business', 'sci-fi', 'self-help', or null>",
    "pages": <page count or null>,
    "themes": ["<key themes or ideas from the book>"]
  }`)}`,

  location: (content, input) => `You are classifying LOCATION-related content (place, travel guide, restaurant review).

${baseContext(content, input)}

Content:
${trimContent(content)}

Focus on:
- Where is this place?
- What type of location is it?
- What can you do there?
- Keywords should include: the location name, city/country, type of place, activities, cuisine (if restaurant)

${standardOutputFormat(`{
    "locationType": "<restaurant | hotel | attraction | city | region | park | null>",
    "address": "<location or area, e.g. 'Tokyo, Japan' or 'Brooklyn, NY'>",
    "activities": ["<things to do or highlights>"],
    "season": "<best time to visit, or null>"
  }`)}`,

  course: (content, input) => `You are classifying a COURSE or structured learning resource.

${baseContext(content, input)}

Content:
${trimContent(content)}

Focus on:
- What does this course teach?
- What platform is it on?
- What level is it aimed at?
- Keywords should include: the subject, platform, technologies taught, skill level, certification if any

${standardOutputFormat(`{
    "instructor": "<instructor/creator name or null>",
    "duration": "<total duration, e.g. '10 hours', '6 weeks', or null>",
    "level": "<beginner | intermediate | advanced | null>",
    "platform": "<platform name, e.g. 'Udemy', 'Coursera', 'YouTube', or null>",
    "topics": ["<specific topics covered>"]
  }`)}`,

  other: (content, input) => `You are classifying content that doesn't fit standard categories.

${baseContext(content, input)}

Content:
${trimContent(content)}

Extract the best title, summary, and keywords you can from this content.

${standardOutputFormat('{}')}`,
};
