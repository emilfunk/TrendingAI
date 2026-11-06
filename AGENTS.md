# TrendingAI — Multi-Agent Guidelines (Codex, Pi, OpenCode, Antigravity, Claude Code)

Universal agent instructions for orchestrating the TrendingAI editorial intelligence pipeline. Auto-loaded by supported AI coding agents (OpenAI Codex, Pi, OpenCode, Google Antigravity, and Claude Code) in this repository.

---

## 1. Project Overview & Architecture

TrendingAI is an editorial intelligence pipeline for AI creator content. It harvests data across 12 channels (X, TikTok, Instagram, YouTube + AI podcasts, Reddit, Hacker News, GitHub, arXiv, Bluesky, editorial feeds, frontier-lab announcements, enterprise feeds), extracts and clusters features via deterministic TypeScript, and synthesizes creator sentiment and narratives inline. Output is written as a self-contained, standalone HTML report to `out/features-confirmed-runNNN-{date}.html`.

### The Inline Synthesis Contract
- **The orchestrating agent model IS the synthesis layer.** Whatever frontier model is driving this session (Opus, GPT-5/o3, Gemini 3.8, etc.) performs the synthesis inline in this active conversation turn-by-turn.
- **NO Task subagents. NO spawning external CLI processes for synthesis.**
- **NO `@anthropic-ai/sdk` or hardcoded vendor SDK dependencies.** The orchestrator reads `prompts/*.md`, takes the input data/envelope, emits the exact JSON schema required by the renderer, and writes it directly to `data/_envelopes/` or `data/*.json`.
- **JSON-schema validation is mandatory.** After every synthesis stage, execute `bun scripts/validate-synthesis.ts --stage <name> --file <path>`. If validation fails (exit code 1), retry once; if it fails again, flag `error: "schema-incomplete"` and continue.

---

## 2. Canonical Entry Points by Runtime

| Runtime | Invocation Command | Context / Skill Discovery | Notes |
|---|---|---|---|
| **Codex** | `$trendingai` or prompt "run trendingai" | Reads `AGENTS.md` & `CODEX.md`; `.agents/skills/trendingai/` | Full-access sandbox in `.codex/config.toml` |
| **Pi** | `/skill:trendingai` or prompt "run trendingai" | Reads `AGENTS.md` & `PI.md`; `.agents/skills/trendingai/` | Native skill auto-discovered from `.agents/skills/` |
| **OpenCode** | `/trendingai` or prompt "run trendingai" | Reads `AGENTS.md` & `OPENCODE.md`; `.opencode/` | Slash command via `.opencode/commands/trendingai.md` |
| **Antigravity** | `/trendingai` or prompt "run trendingai" | Reads `AGENTS.md` & `GEMINI.md`; `.agents/skills/trendingai/` | Discovers workspace skill in `.agents/skills/trendingai/` |
| **Claude Code** | `/trendingai` or prompt "run trendingai" | Reads `AGENTS.md` & `CLAUDE.md`; `.claude/skills/TrendingAI/` | Slash command via `.claude/commands/trendingai.md` |

**Trigger phrases:** `/trendingai`, `run trendingai`, `trending AI report`, `AI trending report`, `run the report`, `let's do our AI trending report`, `fresh trendingai run`, `render-only report`.

---

## 3. Runtime Tool Mapping

Each agent runtime maps abstract operations to its native toolset:

| Abstract Operation | Codex | Pi | OpenCode | Antigravity | Claude Code |
|---|---|---|---|---|---|
| **Shell command** | `bash` / `exec` | `bash` | `bash` | `run_command` | `Bash` |
| **Read file** | Native file read | Native file read | Native file read | `read_file` | `Read` |
| **Write file** | Native file write | Native file write | Native file write | `write_file` | `Write` |
| **Ask user** | Interactive prompt | Interactive prompt | Interactive prompt | `ask_question` / prompt | `AskUserQuestion` |
| **Open browser** | `open out/latest.html` | `open out/latest.html` | `open out/latest.html` | `run_command("open ...")` | `interceptor` / `open` |

---

## 4. Pipeline Execution Workflows

Detailed step-by-step procedures are documented in:
- Fresh Harvest: [`.agents/skills/trendingai/Workflows/Run.md`](.agents/skills/trendingai/Workflows/Run.md)
- Render-Only (cached fast path): [`.agents/skills/trendingai/Workflows/RenderOnly.md`](.agents/skills/trendingai/Workflows/RenderOnly.md)

### Mode 1: Fresh Harvest (~15-20 min wall-clock, ~$0.15-$0.30 hard cost)
1. **Stage 0 — Env Check:** Verify `APIFY_TOKEN` and `GROQ_API_KEY` are present in `.env` or system environment. Prompt user if missing.
2. **Stage 1 — Branch Confirmation:** Confirm fresh harvest vs. render-only and announce estimated spend (~$0.15-$0.30 for Apify + Groq; LLM synthesis is $0 marginal via active subscription).
3. **Stage 2 — Parallel Harvest:** Execute `bun run harvest:all`. Pulls 12 sources in parallel into `data/*.json`.
4. **Stage 3 — Features Extraction:** Execute `bun run features:first`. Deterministic clustering into `data/features-confirmed.json`.
5. **Stage 4 — Feature Sentiment & Cross-Narratives (Inline Synthesis):**
   - Run `bun scripts/build-sentiment-envelopes.ts` to build envelopes in `/tmp/sentiment-envelopes/`.
   - Orchestrator reads `prompts/feature-sentiment.md` and synthesizes JSON per feature into `data/_envelopes/feature-sentiment/{feature_id}.json`.
   - Aggregate via `jq -s '.' data/_envelopes/feature-sentiment/*.json > data/feature-sentiment.json`.
   - Validate schema: `bun scripts/validate-synthesis.ts --stage feature-sentiment --file data/feature-sentiment.json`.
   - Synthesize cross-narratives using `prompts/cross-narratives.md` into `data/cross-narratives.json` and update `feature-sentiment.json`.
   - Validate staleness gate: ensure every `feature_id` in `data/features-confirmed.json` has a corresponding row in `data/feature-sentiment.json`.
6. **Stage 5 — Creator Recommendations (Inline Synthesis):** Backfill null creator recommendations using `prompts/creator-recs.md`.
7. **Stage 6 — Podcast Themes (Inline Synthesis):** Filter YouTube transcripts and synthesize themes using `prompts/podcast-themes.md` into `data/podcast-themes.json`.
8. **Stage 7 — Industry News & Security (Inline Synthesis):** Synthesize events using `prompts/industry-news.md` into `data/industry-news.json`.
9. **Stage 8 — One to Watch:** Execute `bun scripts/classify-one-to-watch.ts`.
10. **Stage 9 — Captions & Quotes:** Execute `bun run features:captions`.
11. **Stage 10 — Render HTML:** Execute `bun run features:render`.
12. **Stage 11 — Archival & Display:**
    - Rename freshly rendered HTML to `out/features-confirmed-run{NNN+1}-{anchor}.html`.
    - Point `out/latest.html` symlink to the new file.
    - Open via `interceptor open file://...` or macOS `open file://...` or print the path.

### Mode 2: Render-Only (~30 sec, $0 cost)
Re-renders from existing `data/*.json` on disk:
```bash
bun scripts/classify-one-to-watch.ts
bun run features:captions
bun run features:render
```
Then increment run number, update `out/latest.html`, and display report.

---

## 5. Non-Negotiable Project Invariants

1. **The renderer is FROZEN:** Do not edit `src/render-features-first.ts` for cosmetic or arbitrary styling tweaks.
2. **Deterministic surfaces are FROZEN:** `src/features-first.ts`, `scripts/classify-one-to-watch.ts`, and `scripts/fetch-captions-and-match.ts` are deterministic algorithms. Do not alter their extraction formulas.
3. **No overwriting baseline or history:** Never overwrite `out/features-confirmed.html` (the bundled immutable reference) or prior numbered runs. Always produce a new `out/features-confirmed-runNNN-*.html` and update `out/latest.html`.
4. **No hallucinated citations:** Every quote, transcript snippet, or URL must trace back to raw harvested data. If a feature has no creator responses, render an honest empty state.
5. **JSON-schema validation is strictly required:** Every synthesis file must pass `validate-synthesis.ts`.
6. **Cost ceiling:** Fresh harvest must remain below ~$0.30 hard costs. Render-only is $0.
