# bookmark-kb Roadmap

## Current State

A bookmark collection + classification pipeline. Bookmarks are collected from multiple sources (GitHub, Raindrop, YouTube, Twitter/X, Discord, manual), extracted, classified by a local LLM (Gemma 4 E4B via llama.cpp), and output as individual Obsidian notes with frontmatter tags and keyword-based related links.

This is a **filing cabinet** — organized, searchable, categorized. The goal is to evolve it into a **living wiki** inspired by Karpathy's LLM Knowledge Base approach, where the LLM doesn't just label content but actively synthesizes, connects, and maintains a growing knowledge graph.

---

## Phase A — Richer Linking

**Effort:** Low | **Value:** High

Right now, related bookmarks are computed by shared keyword overlap. The links are mechanical ("shares keywords: X, Y") with no semantic meaning.

### Changes:
- After processing a bookmark, send the LLM the new note + the 5 most related existing notes
- Ask it to write a one-sentence relationship for each ("implements the technique from...", "contradicts the claim in...", "is a newer alternative to...")
- Embed actual `[[wikilinks]]` naturally in the Summary and Key Content sections, not just a separate Related section
- Result: Obsidian's graph view becomes meaningful — you can see clusters of related ideas, not just keyword coincidences

---

## Phase B — Concept Pages

**Effort:** Medium | **Value:** Very High — this is the jump from filing cabinet to wiki

Individual bookmarks are raw sources. Concept pages are synthesized knowledge. A concept page on "retrieval-augmented-generation" should pull together insights from every bookmark that touches RAG — papers, blog posts, repos, tutorials — into one coherent article.

### Changes:
- Add a `concepts/` folder in the vault
- Track concept candidates: when a keyword accumulates 3+ bookmarks, it becomes a concept candidate
- `compile-concepts` command: for each candidate, send the LLM all related bookmark summaries and ask it to write a concept article
- Concept articles include:
  - A synthesis paragraph (what is this concept, why does it matter)
  - Key resources (links to the best bookmarks on this topic)
  - Related concepts (wikilinks to other concept pages)
  - Open questions (what's unsettled, what to explore next)
- Bookmarks link to concept pages, concept pages link to each other
- Concepts get updated incrementally when new bookmarks arrive on that topic

### Vault structure:
```
vault/
  concepts/
    retrieval-augmented-generation.md
    local-llm-inference.md
    hypermedia-architecture.md
    ...
  articles/
  repos/
  videos/
  ...
```

---

## Phase C — Compilation Pass (Karpathy's Core Loop)

**Effort:** Medium-High | **Value:** High — this is what makes the wiki self-improving

The LLM periodically reviews the wiki as a whole and improves it. This is the "linting" step Karpathy describes.

### Changes:
- `compile` command that runs a multi-step LLM review:
  1. **Gap analysis** — what topics have lots of bookmarks but no concept page?
  2. **Connection discovery** — find non-obvious links between concept pages
  3. **Consistency check** — flag contradictions between sources
  4. **Staleness check** — identify outdated information
  5. **Enhancement suggestions** — propose new questions to research, new sources to find
- Output is a `_compilation_report.md` with actionable items
- Can also auto-apply some fixes (update concept pages, add missing links)

### Key design consideration:
At 4,800+ bookmarks, you can't send everything to the LLM at once. The solution is **machine-readable index files** — one-line summaries per document that let the LLM decide which notes to read in full. Our current `_index_by_tag.md` is human-readable but not useful for LLM navigation. A better format:

```markdown
## Index
- [2026-04-04-karpathy-autoresearch](repos/...) — Framework for autonomous AI research agents on single-GPU training. Tags: ai-agents, llm-training. Quality: deep-dive.
- [2026-04-04-htmx-howl](articles/...) — Essay arguing for polyglot web architectures over JS-only stacks. Tags: htmx, hypermedia. Quality: standard.
```

This compressed index lets the LLM scan thousands of entries in one context window and drill into specific notes as needed.

---

## Phase D — Q&A Interface

**Effort:** Medium | **Value:** High — turns the wiki from passive reference into active research tool

Ask questions against your knowledge base. The LLM reads the index, finds relevant notes, and synthesizes answers. The answers get filed back into the wiki.

### Changes:
- `query "What are the best approaches to local LLM inference?"` command
- LLM reads the master index → identifies relevant notes → reads them in full → writes a research answer
- Output saved as `research/2026-04-04-local-llm-inference-approaches.md` in the vault
- Research notes link back to their source bookmarks
- Over time, research notes become inputs for concept page updates — the wiki compounds

### Karpathy's insight:
> Often, I end up "filing" the outputs back into the wiki to enhance it for further queries. So my own explorations and queries always "add up" in the knowledge base.

This is the flywheel: collect → compile → query → file → compile again.

---

## Phase E — Tool-Augmented Research

**Effort:** High | **Value:** Frontier

Give the LLM tools beyond just reading notes: web search, running code, generating visualizations.

### Ideas:
- Web search tool: when answering a query, the LLM can search for new sources to fill gaps
- Code execution: generate matplotlib charts, data analysis scripts
- Marp slides: render research findings as presentations viewable in Obsidian
- Search engine: a local search API over the wiki that the LLM uses as a tool for large queries

---

## Phase F — Finetuning (Long-term)

**Effort:** Very High | **Value:** Speculative

> As the repo grows, the natural desire is to also think about synthetic data generation + finetuning to have your LLM "know" the data in its weights instead of just context windows.

Once the wiki is large enough, generate Q&A pairs from it and finetune a model that has internalized your knowledge base. This is far out but the wiki structure makes it feasible — concept pages are natural training targets.

---

## Implementation Priority

1. **Phase A** — Do this first. Small change, big improvement to Obsidian usability.
2. **Phase B** — The highest-value phase. This is what turns bookmarks into knowledge.
3. **Phase C** — Do this once Phase B is running and you have 20+ concept pages.
4. **Phase D** — Can be started in parallel with Phase C.
5. **Phase E & F** — Future exploration, not urgent.
