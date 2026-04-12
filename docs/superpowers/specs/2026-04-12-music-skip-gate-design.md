# Music-skip gate design

Date: 2026-04-12
Status: Approved for implementation planning

## Problem

The processing pipeline currently spends significant work on music videos from
YouTube: yt-dlp fetches the video, whisper transcribes the audio, the LLM
classifier writes a summary, the enricher computes related bookmarks, and
images are OCR'd. The resulting Obsidian note is a large file dominated by
whisper-transcribed lyrics and cover-art OCR — content the user does not
want saved or processed.

Example of the current output (not desired):
`vault/media/2026-04-08-21-savage-all-the-smoke-official-audio.md` — 99 lines
including 3 paragraphs of transcribed lyrics and a multi-section OCR of the
cover image.

## Goal

Detect music videos early in the pipeline — before the expensive steps — and
write a minimal Obsidian note that records the link without any transcript,
summary, or enrichment.

## Non-goals

- Retroactive cleanup of music bookmarks already processed under the old
  pipeline. Those ~20+ files are left in place.
- Skipping other content categories (podcasts, short clips, etc.). The gate
  is designed to be extensible, but only `music_video` is wired up in this
  iteration.
- Replacing the main classifier. The gate runs *in addition to* the main
  classifier, not instead of it — the main classifier only runs for
  non-skipped bookmarks.

## Architecture

Insert a new step in `src/processor/pipeline.ts` immediately after
extraction succeeds (Step 2 routes on extraction status; the gate runs on
the `'success'` branch) and before Step 3 (content-based dedup). It sits
ahead of all expensive work: Step 4 (media download), Step 5 (media
processing / whisper), Step 6 (cleanup), Step 8 (classifier), Step 10
(enrichment), Step 12 (Obsidian note).

```
Step 1: extractContent(url)
Step 2: route on extraction status  ─── success ──┐
                                                  ▼
Step 2.5 (NEW): checkSkipGate(content, input)
        ├─ skip=true,  reason='music_video' ──► minimal note, mark skipped, exit
        └─ skip=false                         ──► fall through
                                                  ▼
Step 3–14: unchanged (simhash, media, cleanup, archive, classify,
           keywords, enrich, compile Obsidian note, index, log, dequeue)
```

## Components

### New files

- **`src/processor/skip-gate.ts`** — exposes `checkSkipGate(content, input)`
  that returns a discriminated union:
  ```ts
  type SkipGateResult =
    | { skip: false }
    | { skip: true; reason: 'music_video' };
  ```
  The union is written so future additions (`'podcast_skip'`,
  `'short_video'`, …) are an open enum in one place.
- **`src/llm/skip-gate-prompt.ts`** — the LLM prompt and the JSON schema the
  model must return. Input: `{ title, author, description (truncated to ~500
  chars), categories, source }`. Output: `{ isMusicVideo: boolean; reason:
  string }`.

### Modified files

- **`src/processor/pipeline.ts`** — call `checkSkipGate` after extraction;
  if it returns `skip: true`, call the new minimal-note compiler, update DB
  status, append to `_log.md`, remove from queue, and return.
- **`src/obsidian/compiler.ts`** — add `compileMinimalNote(bookmarkId,
  content, skipReason)`. Writes to `vault/music/` for `music_video`. The
  folder is chosen by the skip reason so future categories map to their own
  folders.
- **`src/db/schema.ts`** — no schema change needed; `status` is a free-form
  `TEXT` column. The new value `'skipped_music'` is introduced by
  convention.
- **`src/db/queries.ts`** — add `markSkipped(bookmarkId, reason, rawPath?)`
  that sets `status = 'skipped_' + reason`, fills `processed_at`, and
  optionally a subset of fields (`title`, `author`, `thumbnail`,
  `content_type = reason`).

## Data flow

```
  extractContent(url) → ExtractedContent
           │
           ▼
  checkSkipGate(content, input) ──► LLM (cheap, metadata-only prompt)
           │
           ├─ skip=true  ──► compileMinimalNote()
           │                  ├─ write vault/music/<slug>.md
           │                  ├─ markSkipped(bookmarkId, 'music_video')
           │                  ├─ appendToLog(title, 'music', source, url)
           │                  ├─ removeFromQueue(bookmarkId)
           │                  └─ return
           │
           └─ skip=false ──► [existing pipeline Steps 2–14]
```

## Minimal note format

Written to `vault/music/<date>-<slug>.md`:

```markdown
---
title: "21 Savage - All The Smoke (Official Audio)"
url: https://youtube.com/watch?v=nYeZKi5pBpM
source: youtube
type: music_video
author: 21 Savage
thumbnail: "https://i.ytimg.com/vi/nYeZKi5pBpM/maxresdefault.jpg"
tags: [music, skipped]
collected: 2026-04-08
processed: 2026-04-12
---

![](https://i.ytimg.com/vi/nYeZKi5pBpM/maxresdefault.jpg)

[Watch on YouTube](https://youtube.com/watch?v=nYeZKi5pBpM)
```

No summary. No transcript. No media processing output. No related-bookmark
section.

## Gate prompt — shape

The prompt gets a JSON blob with metadata only (no transcript, no article
body). Model returns JSON matching:

```json
{
  "isMusicVideo": true,
  "reason": "YouTube category 'Music' and title contains '(Official Audio)'"
}
```

The reason field is for logging and debugging, not stored on the bookmark.

Input size is small (hundreds of tokens), so this is one of the cheapest LLM
calls in the pipeline.

## Error handling

The gate is **fail-open**: any failure means "don't skip, continue the
normal pipeline". Specifically:

- LLM call throws → log warning, treat as `skip: false`.
- LLM returns invalid JSON → log warning, treat as `skip: false`.
- LLM times out (timeout: 15s) → log warning, treat as `skip: false`.
- LLM is unavailable (llama-server down) → log warning, treat as `skip:
  false`.

Rationale: over-processing a music video is annoying. Silently dropping a
tutorial, paper, or article because the gate misfired would be worse.

## Database

No schema migration. `processed_bookmarks.status` already stores arbitrary
text values (`'pending'`, `'completed'`, `'failed'`, `'content_removed'`,
`'paywall'`, `'processing'`). We add one more value: `'skipped_music'`.

Rows written by the minimal-note path:
- `status = 'skipped_music'`
- `content_type = 'music_video'`
- `title`, `author`, `thumbnail` — populated from extracted metadata
- `extracted_text`, `summary`, `category`, `subcategories`,
  `quality_signal`, `actionability` — left NULL
- `obsidian_path` — set to the minimal note path
- `processed_at` — now

Existing status breakdown queries continue to work unchanged.

## Testing

- **Unit tests** for `skip-gate.ts`:
  - Mocked LLM returns `isMusicVideo: true` → function returns
    `{ skip: true, reason: 'music_video' }`.
  - Mocked LLM throws → returns `{ skip: false }`.
  - Mocked LLM returns invalid JSON → returns `{ skip: false }`.
- **Unit tests** for `compileMinimalNote`:
  - Given a YouTube extracted content blob, writes the expected markdown to
    `vault/music/<slug>.md` with no transcript section.
- **Integration test** (manual): pick a known music-video URL and a known
  non-music URL, run through the pipeline with a staged vault directory,
  assert:
  - Music URL → `vault/music/<slug>.md` exists, file length under ~25
    lines, no `## Key Content`, no `## Media` section, no whisper invocation
    (verify via logs).
  - Non-music URL → full note in its normal category folder, all sections
    present as before.

## Rollout

1. Land the feature behind no flag (this is a local single-user tool, no
   production surface).
2. Resume `process-all.sh` after the 2 stuck `status='processing'` rows are
   reset back to pending.
3. Observe log output for the first batch of music videos to verify the
   gate is triggering as expected.
4. If gate misfires frequently (false positives or false negatives), tune
   the prompt; no rollback needed because the gate is fail-open.

## Extensibility

The `SkipGateResult` discriminated union is the extension point. To add
a new skip category later (for example, `short_video`):

1. Extend the union: `| { skip: true; reason: 'short_video' }`.
2. Update the prompt to return the new reason.
3. Add a routing entry in `compileMinimalNote` mapping the new reason to a
   destination folder (e.g., `vault/shorts/`).
4. Add a new DB status value convention: `'skipped_short_video'`.

No changes to callers of `checkSkipGate` are required — they already
handle the discriminated union.
