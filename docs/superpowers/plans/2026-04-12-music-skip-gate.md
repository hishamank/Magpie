# Music-skip gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight LLM pre-classifier immediately after extraction that detects music videos and writes a minimal Obsidian note, skipping whisper transcription, full classification, and enrichment.

**Architecture:** Insert a new `checkSkipGate` step after extraction succeeds in `src/processor/pipeline.ts`. When the gate returns `{ skip: true, reason: 'music_video' }`, the pipeline writes a minimal markdown note to `vault/music/`, marks the bookmark `status='skipped_music'`, logs it, removes it from the queue, and returns. All other bookmarks continue through the existing pipeline unchanged. The gate is fail-open: any LLM error falls through to the normal pipeline.

**Tech Stack:** TypeScript, Node 20+, `better-sqlite3`, local llama-server via `chatCompletion`, `pino` logging. No test framework is installed in this repo; verification is manual (smoke tests via CLI).

**Reference spec:** `docs/superpowers/specs/2026-04-12-music-skip-gate-design.md`

---

## File Structure

**New files:**
- `src/llm/prompts/skip-gate.ts` — prompt builder (`buildSkipGatePrompt`) and raw-response parser (`parseSkipGateResult`)
- `src/processor/skip-gate.ts` — public `checkSkipGate(content, input)` function that returns the discriminated union
- `src/obsidian/minimal-compiler.ts` — `compileMinimalNote(bookmarkId, reason)` that writes `vault/music/<slug>.md`

**Modified files:**
- `src/db/queries.ts` — add `markSkipped(bookmarkId, reason)` helper
- `src/processor/pipeline.ts` — call `checkSkipGate` in the `success` branch of step 2, branch to minimal path when `skip: true`

**No schema migration.** `processed_bookmarks.status` is free-form TEXT.

---

## Task 0: Pause processing and reset stuck rows

**Files:**
- None (operational)

Before any code change, make sure nothing is running and the DB is clean.

- [ ] **Step 1: Stop the running batch processor**

Run:
```bash
kill 1271494 2>/dev/null; pkill -f "tsx.*src/index.ts process"; sleep 1; ps -ef | grep -E "process-all|tsx.*process" | grep -v grep
```

Expected: no surviving `process-all.sh` or `tsx ... process` rows. PIDs may differ; find the live `process-all.sh` first with `ps -ef | grep process-all | grep -v grep` if 1271494 is no longer current.

- [ ] **Step 2: Reset the 2 stuck `status='processing'` rows back to pending**

Run:
```bash
sqlite3 data/bookmark-kb.db "UPDATE processed_bookmarks SET status='pending', error_message='reset-pre-music-skip-gate', updated_at=datetime('now') WHERE status='processing';"
sqlite3 data/bookmark-kb.db "SELECT status, COUNT(*) FROM processed_bookmarks GROUP BY status;"
```

Expected: no rows with `status='processing'` remain. Other statuses unchanged.

- [ ] **Step 3: Commit nothing (operational only, no code change)**

Skip — no files to commit yet.

---

## Task 1: Add `markSkipped` DB helper

**Files:**
- Modify: `src/db/queries.ts` (append new function near `markContentRemoved`, around line 399)

- [ ] **Step 1: Add `markSkipped` helper**

Open `src/db/queries.ts` and locate `markContentRemoved` (around line 399). Immediately after it, add:

```typescript
/**
 * Mark a bookmark as skipped by the pre-classifier skip gate.
 * `reason` is the skip category (e.g. 'music_video'). The DB status is
 * stored as `'skipped_' + reason` so existing status-breakdown queries
 * can tell the categories apart.
 */
export function markSkipped(
  bookmarkId: number,
  reason: string,
  fields: {
    title?: string;
    author?: string;
    thumbnail?: string;
    obsidianPath?: string;
  },
): void {
  upsertProcessedBookmark(bookmarkId, {
    status: `skipped_${reason}`,
    contentType: reason,
    title: fields.title,
    author: fields.author,
    thumbnail: fields.thumbnail,
    obsidianPath: fields.obsidianPath,
    processedAt: new Date().toISOString(),
  });
  const db = getDb();
  db.prepare('DELETE FROM processing_queue WHERE bookmark_id = ?').run(bookmarkId);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/db/queries.ts
git commit -m "feat(db): add markSkipped helper for skip-gate"
```

---

## Task 2: Add skip-gate prompt and parser

**Files:**
- Create: `src/llm/prompts/skip-gate.ts`

- [ ] **Step 1: Create the prompt + parser module**

Create `src/llm/prompts/skip-gate.ts` with this exact content:

```typescript
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

  const isMusicVideo = parsed.isMusicVideo === true;
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
  return { isMusicVideo, reason };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/llm/prompts/skip-gate.ts
git commit -m "feat(llm): add skip-gate prompt and parser"
```

---

## Task 3: Add `checkSkipGate` entry point

**Files:**
- Create: `src/processor/skip-gate.ts`

- [ ] **Step 1: Create the skip-gate module**

Create `src/processor/skip-gate.ts` with this exact content:

```typescript
import { chatCompletion } from '../llm/client.js';
import { buildSkipGatePrompt, parseSkipGateResult } from '../llm/prompts/skip-gate.js';
import type { ExtractedContent } from '../extractors/types.js';
import type { BookmarkInput } from '../collectors/types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('skip-gate');

const GATE_TIMEOUT_MS = 15_000;

export type SkipReason = 'music_video';

export type SkipGateResult =
  | { skip: false }
  | { skip: true; reason: SkipReason };

/**
 * Lightweight pre-classifier. Decides whether to skip the full processing pipeline.
 *
 * Fail-open: any LLM error, parse failure, or timeout returns { skip: false } so
 * the normal pipeline handles the bookmark. Silently skipping a non-music URL
 * would be worse than over-processing a music one.
 */
export async function checkSkipGate(
  content: ExtractedContent,
  input: BookmarkInput,
): Promise<SkipGateResult> {
  const prompt = buildSkipGatePrompt(content, input);

  let raw: string;
  try {
    raw = await Promise.race([
      chatCompletion(prompt, { format: 'json', temperature: 0.1 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`skip-gate timeout after ${GATE_TIMEOUT_MS}ms`)), GATE_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    logger.warn({ url: input.url, err: (err as Error).message }, 'skip-gate LLM call failed — continuing normal pipeline');
    return { skip: false };
  }

  let decision;
  try {
    decision = parseSkipGateResult(raw);
  } catch (err) {
    logger.warn({ url: input.url, err: (err as Error).message, raw: raw.slice(0, 200) }, 'skip-gate parse failed — continuing normal pipeline');
    return { skip: false };
  }

  if (decision.isMusicVideo) {
    logger.info({ url: input.url, reason: decision.reason }, 'skip-gate: music_video — skipping full pipeline');
    return { skip: true, reason: 'music_video' };
  }

  logger.debug({ url: input.url, reason: decision.reason }, 'skip-gate: not music, continuing');
  return { skip: false };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/processor/skip-gate.ts
git commit -m "feat(processor): add checkSkipGate pre-classifier"
```

---

## Task 4: Add minimal Obsidian compiler

**Files:**
- Create: `src/obsidian/minimal-compiler.ts`

- [ ] **Step 1: Create the minimal compiler module**

Create `src/obsidian/minimal-compiler.ts` with this exact content:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { slugify } from './templates.js';
import type { ExtractedContent } from '../extractors/types.js';
import type { BookmarkInput } from '../collectors/types.js';
import type { SkipReason } from '../processor/skip-gate.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('obsidian:minimal-compiler');

/**
 * Map a skip reason to the vault subfolder for its minimal notes.
 */
const REASON_FOLDER: Record<SkipReason, string> = {
  music_video: 'music',
};

/**
 * Write a minimal Obsidian note for a bookmark that the skip gate
 * decided not to process. Only frontmatter + thumbnail + link.
 *
 * Returns the vault-relative path to the written file.
 */
export function compileMinimalNote(
  bookmarkId: number,
  content: ExtractedContent,
  input: BookmarkInput,
  reason: SkipReason,
): string {
  const folder = REASON_FOLDER[reason];
  const title = content.title || input.title || 'Untitled';
  const date = (input.collectedAt ?? new Date()).toISOString().slice(0, 10);
  const processedDate = new Date().toISOString().slice(0, 10);
  const noteName = `${date}-${slugify(title)}`;
  const relativePath = path.join(folder, `${noteName}.md`);
  const fullPath = path.join(config.vault.path, relativePath);

  const thumbnail = content.images?.[0] || '';
  const author = content.author || '';

  const lines: string[] = [];
  lines.push('---');
  lines.push(`title: "${title.replace(/"/g, '\\"')}"`);
  lines.push(`url: ${input.url}`);
  lines.push(`source: ${input.source}`);
  lines.push(`type: ${reason}`);
  if (author) lines.push(`author: ${author}`);
  if (thumbnail) lines.push(`thumbnail: "${thumbnail}"`);
  lines.push('tags: [music, skipped]');
  lines.push(`collected: ${date}`);
  lines.push(`processed: ${processedDate}`);
  lines.push('---');
  lines.push('');
  if (thumbnail) {
    lines.push(`![](${thumbnail})`);
    lines.push('');
  }
  const linkLabel = input.source === 'youtube' ? 'Watch on YouTube' : 'Open';
  lines.push(`[${linkLabel}](${input.url})`);
  lines.push('');

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, lines.join('\n'), 'utf-8');

  logger.info({ bookmarkId, path: relativePath, reason }, 'Minimal Obsidian note written');
  return relativePath;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/obsidian/minimal-compiler.ts
git commit -m "feat(obsidian): add minimal-note compiler for skipped bookmarks"
```

---

## Task 5: Wire the gate into the processing pipeline

**Files:**
- Modify: `src/processor/pipeline.ts` (imports + success branch in `processBookmark`)

- [ ] **Step 1: Add imports**

At the top of `src/processor/pipeline.ts`, in the import block (around lines 1–30), add two new imports:

After the `classifier` import:
```typescript
import { checkSkipGate } from './skip-gate.js';
```

After the `compileObsidianNote` import:
```typescript
import { compileMinimalNote } from '../obsidian/minimal-compiler.js';
```

Also, pull `markSkipped` into the db-queries import block that currently reads:
```typescript
import {
  getBookmarkByUrlHash,
  insertBookmark,
  upsertProcessedBookmark,
  updateProcessingStatus,
  updateObsidianPath,
  incrementQueueAttempt,
  removeFromQueue,
  addToProcessingQueue,
  markContentRemoved,
  requeueWithDelay,
  updateExtractionStatus,
} from '../db/queries.js';
```

Change it to add `markSkipped`:
```typescript
import {
  getBookmarkByUrlHash,
  insertBookmark,
  upsertProcessedBookmark,
  updateProcessingStatus,
  updateObsidianPath,
  incrementQueueAttempt,
  removeFromQueue,
  addToProcessingQueue,
  markContentRemoved,
  markSkipped,
  requeueWithDelay,
  updateExtractionStatus,
} from '../db/queries.js';
```

- [ ] **Step 2: Insert the gate call in the success branch**

Locate this block in `processBookmark` (currently around lines 107–115):

```typescript
      case 'success':
        // Continue with processing pipeline below
        break;
    }

    const content = result.content!;

    // Step 3: Content-based dedup check
    const contentHash = computeSimhash(content.text);
```

Replace it with:

```typescript
      case 'success':
        // Continue with processing pipeline below
        break;
    }

    const content = result.content!;

    // Step 2.5: Skip gate — cheap LLM check on metadata only.
    // If this is a music video (or another skip category in the future),
    // write a minimal note and bail before we run the expensive steps.
    const gate = await checkSkipGate(content, input);
    if (gate.skip) {
      const minimalPath = compileMinimalNote(bookmarkId, content, input, gate.reason);
      markSkipped(bookmarkId, gate.reason, {
        title: content.title || input.title,
        author: content.author,
        thumbnail: content.images?.[0],
        obsidianPath: minimalPath,
      });
      appendToLog(
        content.title || input.title || '',
        gate.reason,
        input.source,
        input.url,
      );
      logger.info({ url: input.url, reason: gate.reason, path: minimalPath }, 'Bookmark skipped by gate');
      return;
    }

    // Step 3: Content-based dedup check
    const contentHash = computeSimhash(content.text);
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/processor/pipeline.ts
git commit -m "feat(pipeline): branch through skip-gate before expensive steps"
```

---

## Task 6: Smoke-test the gate end-to-end

**Files:**
- None (verification only)

This repo has no unit-test framework. We verify by running the real pipeline against a known music URL and a known non-music URL.

- [ ] **Step 1: Pick test URLs from the pending queue**

Run:
```bash
sqlite3 data/bookmark-kb.db "SELECT b.id, b.url FROM bookmarks b JOIN processing_queue q ON q.bookmark_id = b.id LEFT JOIN processed_bookmarks pb ON pb.bookmark_id = b.id WHERE (pb.id IS NULL OR pb.status='pending') AND b.url LIKE '%youtube%' ORDER BY RANDOM() LIMIT 5;"
```

Pick one that is clearly a music video (e.g. title like "...Official Video" or "...Official Audio") and one that is clearly not (e.g. a tutorial or podcast). Note the two bookmark IDs.

- [ ] **Step 2: Process the music URL**

`npx tsx src/index.ts process` only accepts `--limit` / `--dry-run` (no `--id`). Use a one-off inline script. Replace `<MUSIC_ID>` with the music bookmark ID:

```bash
npx tsx --eval "
import('./src/db/queries.js').then(async ({ getBookmarkById }) => {
  const { processBookmark } = await import('./src/processor/pipeline.js');
  const { initSchema } = await import('./src/db/schema.js');
  initSchema();
  const row = getBookmarkById(<MUSIC_ID>);
  if (!row) { console.error('not found'); process.exit(1); }
  await processBookmark({
    url: row.url,
    title: row.title ?? undefined,
    source: row.source,
    sourceId: row.source_id ?? undefined,
    mediaType: row.media_type ?? undefined,
    sourceMetadata: row.source_metadata ? JSON.parse(row.source_metadata) : undefined,
    collectedAt: new Date(row.collected_at),
  }, row.id);
  process.exit(0);
});
" 2>&1 | tee /tmp/skip-gate-music.log
```

Inspect the log. Expected: a line `skip-gate: music_video — skipping full pipeline`, followed by `Minimal Obsidian note written`, followed by `Bookmark skipped by gate`. No `Step 1: type detected`, no `Processing media` lines.

- [ ] **Step 3: Verify DB + vault for the music URL**

```bash
sqlite3 data/bookmark-kb.db "SELECT bookmark_id, status, content_type, obsidian_path FROM processed_bookmarks WHERE bookmark_id=<MUSIC_ID>;"
ls -la vault/music/
wc -l vault/music/*.md | tail -5
```

Expected: `status=skipped_music_video`, `content_type=music_video`, `obsidian_path` starts with `music/`. The created file in `vault/music/` should be fewer than 25 lines.

- [ ] **Step 4: Inspect the minimal note**

```bash
cat "vault/$(sqlite3 data/bookmark-kb.db "SELECT obsidian_path FROM processed_bookmarks WHERE bookmark_id=<MUSIC_ID>;")"
```

Expected content shape:
```
---
title: "..."
url: ...
source: youtube
type: music_video
author: ...
thumbnail: "..."
tags: [music, skipped]
collected: YYYY-MM-DD
processed: YYYY-MM-DD
---

![](...)

[Watch on YouTube](...)
```

No `## Summary`, no `## Key Content`, no `## Media`, no `## Related Bookmarks`.

- [ ] **Step 5: Process the non-music URL**

Replace `<NONMUSIC_ID>` and run the same inline-script form used in Step 2, substituting the ID:

```bash
npx tsx --eval "
import('./src/db/queries.js').then(async ({ getBookmarkById }) => {
  const { processBookmark } = await import('./src/processor/pipeline.js');
  const { initSchema } = await import('./src/db/schema.js');
  initSchema();
  const row = getBookmarkById(<NONMUSIC_ID>);
  if (!row) { console.error('not found'); process.exit(1); }
  await processBookmark({
    url: row.url,
    title: row.title ?? undefined,
    source: row.source,
    sourceId: row.source_id ?? undefined,
    mediaType: row.media_type ?? undefined,
    sourceMetadata: row.source_metadata ? JSON.parse(row.source_metadata) : undefined,
    collectedAt: new Date(row.collected_at),
  }, row.id);
  process.exit(0);
});
" 2>&1 | tee /tmp/skip-gate-nonmusic.log
```

Expected: a line `skip-gate: not music, continuing` (debug level — may only appear if `LOG_LEVEL=debug`). The full pipeline runs — you should see `Step 1: type detected`, `Step 2: type-specific classification complete`, and eventually `Bookmark processed successfully`. The resulting note lives in one of the normal category folders, not `vault/music/`.

- [ ] **Step 6: If anything fails, diagnose before moving on**

Common issues and fixes:
- Gate mis-flags a non-music video as music → inspect `/tmp/skip-gate-*.log` for the `reason` field, tune `buildSkipGatePrompt` if needed, and commit the tweak separately.
- Gate misses an obvious music video → same: tune the prompt, commit separately.
- File written to wrong folder → check `REASON_FOLDER` map in `minimal-compiler.ts`.
- Typecheck passes but runtime throws → `logger.error` should contain a stack trace; most likely an import path with a missing `.js` suffix.

- [ ] **Step 7: No commit (verification only)**

Skip — this task is a test run, no files change.

---

## Task 7: Resume batch processing

**Files:**
- None (operational)

- [ ] **Step 1: Confirm everything is in place**

Run:
```bash
git log --oneline -7
sqlite3 data/bookmark-kb.db "SELECT status, COUNT(*) FROM processed_bookmarks GROUP BY status;"
```

Expected: 5 new commits since `40e65a5` (the spec commit) — `markSkipped helper`, `skip-gate prompt`, `checkSkipGate`, `minimal compiler`, `pipeline wiring` (Task 6 adds none). DB status breakdown shows no `processing` rows.

- [ ] **Step 2: Resume `process-all.sh`**

Run:
```bash
nohup ./process-all.sh > process.log 2>&1 &
echo "started: $!"
tail -f process.log
```

Watch the first few batches. Expected: roughly the same throughput as before for non-music bookmarks, plus occasional `Bookmark skipped by gate` lines for music. Ctrl-C the `tail` once you've seen at least one skip and one normal processing.

- [ ] **Step 3: No commit (operational only)**

Skip.

---

## Self-Review Checklist

Verified:

- **Spec coverage:**
  - Architecture diagram → Task 5 wiring
  - `src/processor/skip-gate.ts` → Task 3
  - `src/llm/skip-gate-prompt.ts` → Task 2 (named `src/llm/prompts/skip-gate.ts` to match existing `src/llm/prompts/` convention — spec path adjusted)
  - Pipeline branch → Task 5
  - `compileMinimalNote` → Task 4
  - `markSkipped` DB helper → Task 1
  - Minimal note format → Task 4 and Task 6 Step 4 validation
  - Gate prompt shape → Task 2
  - Fail-open error handling → Task 3 (catches timeout, throw, and parse errors independently)
  - DB status value `skipped_music_video` → Task 1 (stored as `skipped_${reason}`; the spec loosely named it `skipped_music`, but the reason is `music_video` so the final value is `skipped_music_video` for clarity and future-proofing)
  - Rollout steps 1–3 → Tasks 0 and 7
  - Extensibility (open union) → Task 3 (`SkipReason` type) and Task 4 (`REASON_FOLDER` map)
  - Testing → Task 6 (manual smoke tests — no unit framework exists, consistent with rest of codebase)

- **Placeholder scan:** no TBDs, no "add error handling" hand-waves, no "similar to Task N"; every step has exact code or exact commands.

- **Type consistency:**
  - `SkipGateResult` defined in Task 3, consumed in Task 5 with matching `.skip` / `.reason` discriminant.
  - `SkipReason` defined in Task 3, imported into `minimal-compiler.ts` in Task 4.
  - `markSkipped` signature `(bookmarkId, reason, fields)` defined in Task 1 and called identically in Task 5.
  - `compileMinimalNote(bookmarkId, content, input, reason)` defined in Task 4 and called identically in Task 5.

- **Scope:** single focused feature, one implementation plan.

One spec-vs-plan deviation worth flagging to the user: the spec says the DB status becomes `'skipped_music'`. In the plan it becomes `'skipped_music_video'` because `markSkipped` derives the status from the skip reason (`music_video`) — keeps the open-enum extension clean. Functionally equivalent, slightly more specific. If you want the literal `'skipped_music'` instead, change Task 1's template string from `\`skipped_${reason}\`` to `'skipped_music'` (and broaden if more reasons are added later).
