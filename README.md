# bookmark-kb

Personal bookmark knowledge base. Collects bookmarks from Twitter/X, YouTube, GitHub, Raindrop.io, and Discord, scrapes their content, classifies them using a local LLM, and compiles everything into a structured Obsidian vault backed by SQLite.

Inspired by [Karpathy's approach](https://x.com/karpathy) to LLM-powered personal knowledge bases — raw data is collected, then "compiled" by an LLM into a markdown wiki that can be browsed, searched, and queried.

## How it works

```
Sources (Twitter, YouTube, GitHub, Raindrop, Discord)
  → Collect bookmarks
  → Extract content (Readability, yt-dlp, GitHub API, Playwright)
  → Classify with local LLM (Gemma 4 via llama.cpp)
  → Generate Obsidian notes with frontmatter, tags, and wikilinks
  → Maintain auto-generated index files
```

Each bookmark becomes a `.md` file with:
- YAML frontmatter (category, tags, actionability, quality signal)
- LLM-generated summary
- Extracted content
- Related bookmarks via shared keywords
- Source metadata and archive link

## Requirements

- Node.js 20+
- pnpm
- llama.cpp server running locally (see [setup](#llm-setup))
- yt-dlp (for YouTube)
- Playwright Chromium (for Twitter and fallback extraction)

## Install

```bash
git clone <repo-url> ~/Projects/bookmark-kb
cd ~/Projects/bookmark-kb
pnpm install
npx playwright install chromium
```

### Global command

To use `bookmark-kb` from anywhere on the server:

```bash
pnpm link --global
```

Then you can run `bookmark-kb <command>` from any directory.

### Local scripts

From the project directory, you can use pnpm scripts:

```bash
pnpm status          # Show queue stats
pnpm health          # Check DB, LLM, vault status
pnpm collect         # Collect from all sources
pnpm process         # Process pending bookmarks (default: 10)
pnpm search          # Search bookmarks
pnpm reindex         # Regenerate Obsidian index files
pnpm serve           # Start Discord bot + cron scheduler
pnpm process:all     # Process all pending in batches (long-running)
```

For commands that need arguments, use `pnpm bkb`:

```bash
pnpm bkb collect github --limit 10 --dry-run
pnpm bkb process --limit 50
pnpm bkb add "https://example.com/article"
pnpm bkb search "machine learning"
```

## Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `LLM_SERVER_URL` | Yes | llama.cpp server URL (default: `http://localhost:8080`) |
| `GITHUB_TOKEN` | For GitHub | Personal access token with `read:user` scope |
| `RAINDROP_TOKEN` | For Raindrop | Test token from app.raindrop.io/settings/integrations |
| `TWITTER_COOKIES_PATH` | For Twitter | Path to X cookies JSON file |
| `YOUTUBE_COOKIES_PATH` | For YouTube | Path to YouTube cookies.txt (Netscape format) |
| `DISCORD_BOT_TOKEN` | For Discord | Bot token from discord.com/developers |
| `DISCORD_CHANNEL_ID` | For Discord | Channel ID to listen for URLs |
| `DB_PATH` | No | SQLite database path (default: `./data/bookmark-kb.db`) |
| `VAULT_PATH` | No | Obsidian vault output path (default: `./vault`) |
| `ARCHIVE_PATH` | No | Raw content archive path (default: `./data/raw`) |

### Cookie files

**YouTube** — Netscape cookies.txt format. Export from your browser using a cookies extension while on youtube.com.

**Twitter/X** — JSON array exported from browser. Only cookies for `.x.com` and `.twitter.com` domains are used. The key cookies are `auth_token` and `ct0`.

## Usage

### Collect bookmarks

```bash
# From all configured sources
bookmark-kb collect

# From a specific source
bookmark-kb collect github
bookmark-kb collect raindrop
bookmark-kb collect youtube
bookmark-kb collect twitter

# Preview without saving
bookmark-kb collect --dry-run

# Limit items
bookmark-kb collect github --limit 20
```

Collectors are incremental — running them again will only pick up new bookmarks. Deduplication works on two levels: source ID matching (fast) and URL hash matching (catches cross-source duplicates).

### Process bookmarks

Processing extracts content, classifies with the LLM, and generates Obsidian notes.

```bash
# Process a batch (default: 10)
bookmark-kb process

# Process more at once
bookmark-kb process --limit 50

# Preview what would be processed
bookmark-kb process --dry-run

# Process everything (runs in a loop until done)
./process-all.sh
# Or in background:
nohup ./process-all.sh > process.log 2>&1 &
```

### Add a single URL

```bash
bookmark-kb add "https://example.com/interesting-article"
bookmark-kb add "https://github.com/user/repo" --title "Cool project"
```

### Search

```bash
bookmark-kb search "RAG pipeline"
bookmark-kb search "typescript" --limit 50
```

### Check status

```bash
bookmark-kb status    # Queue stats, counts by source and category
bookmark-kb health    # Check DB, LLM server, vault, archive
```

### Long-running mode

Starts the Discord bot and schedules automatic collection and processing:

```bash
bookmark-kb serve
```

Cron schedule in serve mode:
- Twitter: every 6 hours
- YouTube: every 12 hours
- GitHub: every 24 hours
- Raindrop: every 6 hours
- Process queue: every 30 minutes

## Obsidian vault

Open `./vault` as an Obsidian vault. The structure:

```
vault/
  _index.md              # Master index with stats
  _index_by_category.md  # All bookmarks grouped by category
  _index_by_tag.md       # All tags with linked bookmarks
  _recent.md             # Last 50 bookmarks
  _to_read.md            # Reading/watch list sorted by quality
  articles/              # Articles, blog posts, news
  repos/                 # GitHub repositories
  videos/                # YouTube videos
  guides/                # Tutorials and guides
  papers/                # Academic papers
  tools/                 # Tools and utilities
  tweets/                # Tweet threads
  recipes/               # Recipes
  books/                 # Books
  movies/                # Movies
  trading/               # Trading-related content
```

### Recommended Obsidian plugins

- **Dataview** — query your bookmarks with SQL-like syntax
- **Graph View** (built-in) — visualize connections between notes
- **Tag Wrangler** — manage tags across notes

## LLM setup

This project uses llama.cpp with the Gemma 4 E4B model. The server must be running before processing bookmarks.

```bash
# Start the server (example for AMD iGPU with Vulkan)
/opt/llama.cpp/build/bin/llama-server \
  -hf ggml-org/gemma-4-E4B-it-GGUF:Q4_K_M \
  -c 8192 -t 10 -ngl 40 \
  --batch-size 1024 --ubatch-size 512 \
  --threads-http 4 --mlock \
  --host 0.0.0.0 --port 8080
```

See `ROADMAP.md` for planned improvements including concept pages, compilation passes, and Q&A interface.
