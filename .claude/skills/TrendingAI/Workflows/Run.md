# Workflow — Run (full pipeline orchestration)

The canonical TrendingAI pipeline workflow. Invoked when user says any of the trigger phrases. Walks through env-check → fresh-vs-render choice → harvest (if fresh) → features-first → 4 synthesis stages (inline Opus) → 2 deterministic post-stages → render → display.

This file is YOUR (Opus 4.7's) operating manual for the run. Read top-to-bottom before acting. Each `### Stage N` block is one operation with a stop condition before moving on.

---

## Stage 0 — Env-var questionnaire

Read the bundle's `.env` if it exists, else read environment. Check for `APIFY_TOKEN` and `GROQ_API_KEY`. Both must be set.

```bash
# Check the bundle's .env
if [ -f ./.env ]; then
  set -a; source ./.env; set +a
fi
# Validate
test -n "$APIFY_TOKEN" && echo "✅ APIFY_TOKEN set" || echo "❌ APIFY_TOKEN missing"
test -n "$GROQ_API_KEY" && echo "✅ GROQ_API_KEY set" || echo "❌ GROQ_API_KEY missing"
```

If either is missing, ask via `AskUserQuestion`:
- "I need your Apify token to harvest social/podcast data. Sign up at https://apify.com (free tier ~$5 credit, no card). Find your token at https://console.apify.com/account/integrations. Paste it here (starts with `apify_api_`):"
- "I need your Groq API key for podcast/IG audio transcription. Sign up at https://console.groq.com (free tier covers our volume). Paste it here (starts with `gsk_`):"

After they paste, write to `./.env`:
```bash
cat > ./.env <<EOF
APIFY_TOKEN=<their_apify_token>
GROQ_API_KEY=<their_groq_token>
HARVEST_PAID=1
EXTRACT_TT_TRANSCRIPTS=1
EXTRACT_IG_TRANSCRIPTS=1
EOF
chmod 600 ./.env
```

Re-validate. Both set → narrate `✅ env: APIFY_TOKEN + GROQ_API_KEY validated. Paid-harvest gates enabled.`

**Stop condition:** both env vars validated. If user refuses to provide one, halt with explanation; do not continue.

---

## Stage 1 — Fresh-harvest vs render-only

Ask via `AskUserQuestion`:
- "Fresh harvest" — runs all 12 source harvesters + full synthesis + render. ~15-20 min. ~$0.30 hard cost.
- "Render-only" — uses the cached `data/*.json` from the bundle. ~30 sec. $0 cost. Useful for seeing the structure before paying for fresh data.

If "Render-only", switch to `Workflows/RenderOnly.md`.

If "Fresh harvest", confirm cost expectation: `📊 Estimated cost ~$0.30 hard $ (Apify + Groq). Anthropic Opus is $0 marginal (subscription-billed). Free Apify tier ($5 credit) covers ~15-25 runs.` Then continue.

---

## Stage 2 — Harvest (fresh path only, ~5-8 min)

```bash
# The bundle's package.json directory IS the cwd when run via `bun run`.
# All paths in the bundle are relative — no cd needed if you opened claude here.
mkdir -p data/raw
time bun run harvest:all 2>&1 | tee /tmp/trendingai-harvest.log
```

Narrate: `🌐 harvest started · 12 sources in parallel · t=0s`. Watch the stderr. Each source completion: `✅ harvested {source} · {N} items · t={Ns}s`.

After harvest completes, verify outputs:
```bash
for src in x tiktok instagram youtube hn reddit github arxiv bluesky frontier editorial enterprise; do
  if [ -f "data/${src}.json" ]; then
    cnt=$(jq -r 'if type=="array" then length else (.items|length) end' "data/${src}.json" 2>/dev/null)
    echo "  ${src}: ${cnt} items"
  else
    echo "  ${src}: MISSING"
  fi
done
```

Narrate the inventory: `📦 harvest done · X items collected · Y of 12 sources non-empty`. If any source is missing AND was expected non-empty (x/tt/ig/youtube/frontier are the load-bearing ones), surface to user before continuing. The pipeline can run with reduced sources but the editorial output will be thinner.

**Stop condition:** non-empty harvest with at least x.json, tiktok.json, youtube.json, frontier.json present.

---

## Stage 3 — Features-first (deterministic, ~15 sec)

```bash
time bun run features:first 2>&1 | tail -10
```

This runs `src/features-first.ts` — entity extraction, cross-platform substring match, ≥2 platforms AND ≥3 creators threshold, writes `data/features-confirmed.json`. Pure code, no LLM, deterministic.

Verify:
```bash
jq 'length' data/features-confirmed.json
jq '[.[].title]' data/features-confirmed.json
```

Narrate: `🎯 features-first done · N confirmed features identified`.

**Stop condition:** `data/features-confirmed.json` exists and has length ≥ 1.

---

## Stage 4 — Synthesis: feature-sentiment + cross-narratives (inline Opus, ~5-8 min)

This is the biggest synthesis stage. 14 (or however many) confirmed features, each gets one synthesis call producing the JSON shape the renderer expects.

**ARCHITECTURE LOCK (Kem 2026-05-26):** all synthesis here happens INLINE in my own context. No Task subagents. No parallel spawning. Process the features in sequence: I read one feature's data, synthesize it, write the envelope, move to the next. Sequential, single-window, predictable. The user can see every step happen in the same conversation.

### 4a — Per-feature pass

Read these files into your context:
1. `prompts/feature-sentiment.md` — system prompt (use VERBATIM as your system context for each synthesis)
2. `data/features-confirmed.json` — the N features
3. `data/x.json`, `data/tiktok.json`, `data/instagram.json`, `data/youtube.json` — source items to look up by URL (needed for raw_text and transcripts in items)
4. `data/comment-sentiment.json` — optional, used for [REPLY SIGNAL] tags on X items if present

For each feature in `features-confirmed.json`:

**Build the user prompt envelope** matching the format the SYS expects.

**Canonical path (iter-46 close):** run `bun scripts/build-sentiment-envelopes.ts` — a deterministic helper that performs steps (a)–(d) below for every feature and writes per-feature envelope text files to `/tmp/sentiment-envelopes/{feature_id}.txt` plus a `_manifest.json`. The orchestrator then reads each envelope and synthesizes inline (next bold block). The steps below document what the script does, kept as the reference contract:

a) Rank the feature's `responses[]` by (match_in priority: transcript=3, raw_text=2, title=1) then by engagement descending. Take top 25.

b) For each selected response:
   - Look up the source item by URL in the relevant source JSON (e.g. `data/x.json` for X items)
   - Resolve the author (use `meta.author` fallback; for YouTube parse `[Channel Name]` from title)
   - Get the item text: if `match_in == "transcript"`, take a 600-char window from `meta.transcript` around the matched_entity (200 chars before, 400 after); else use `raw_text || title`; cap at 600 chars
   - Determine if it's a podcast: source == "youtube" → yes, extract video_id from URL + show_name from title prefix
   - If `comment-sentiment.json` has an entry for this URL's status-id (X items): compute pos%/neg% and ratioed flag (total >= 10 AND pos < 40 = ratioed)
   - Check if author is in LAB_AFFILIATED set (handles: bcherny, sama, boris, thsottiaux, alexalbert__, karpathy, AnthropicAI, anthropicai, ClaudeDevs, claudedevs, claudeai, ClaudeAI, OpenAI, openai, GeminiApp, Google, GoogleDeepMind, xai, elonmusk, miramurati, gdb, fchollet, demishassabis)

c) Compute the deterministic tutorial-hype score for the feature's top items. The patterns are 8 regex tests (see `src/feature-sentiment.ts` `TUTORIAL_HYPE_PATTERNS` for canonical list — copy them inline). Score per item = count of pattern matches. Aggregate: hyped_items = count of items with score ≥ 2. dominant if hyped_items ≥ 2 AND hyped_items / total ≥ 0.4.

d) Emit the user prompt envelope text matching the structure shown at the bottom of `prompts/feature-sentiment.md`.

**Synthesize** the JSON output. The contract is the schema in `prompts/feature-sentiment.md`. Do this inline using your own Opus brain in the main conversation. NO Task subagent. NO subprocess. NO spawning of any kind. Just me reading the prompt, reading the envelope, producing the JSON, and writing it to `data/_envelopes/feature-sentiment/{feature_id}.json`. Process features one at a time, sequentially, in feature_id order.

**Validate** the output JSON against required keys: `overall_sentiment`, `dominant_pattern`, `summary_sentence`, `praises`, `complaints`, `notable_quotes`, `cited_items_why`. If any required key is missing, retry the synthesis ONCE; if still missing, mark the row with `error: "schema-incomplete"` and move on.

After all features processed, aggregate the per-feature JSONs into `data/feature-sentiment.json` as a single array:
```bash
jq -s '.' data/_envelopes/feature-sentiment/*.json > data/feature-sentiment.json
```

Narrate per feature: `  ✅ [N/M] feature_id={id} → {overall_sentiment} [{dominant_pattern}]`.

### 4b — Cross-narrative pass

Read `prompts/cross-narratives.md` as system. Read all rows from `data/feature-sentiment.json` (just need feature_id + title + dominant_pattern + overall_sentiment + summary_sentence per row). Build a single batch user prompt. Synthesize inline. Validate JSON shape (root `narratives` is an array, each entry has `narrative_id` + `implicated_feature_ids[]` length ≥ 2 + `substrate_sentence`). Write to `data/cross-narratives.json`.

After it returns, update each implicated row in `feature-sentiment.json` — append `narrative_id` to that row's `cross_narrative_ids` array. Re-write `data/feature-sentiment.json` with the updates.

Narrate: `🔗 cross-narratives done · {N_narratives} substrate threads ({N_high} high · {N_med} med · {N_low} low)`.

**Stop condition:** `data/feature-sentiment.json` valid JSON array of N rows, each with required keys. `data/cross-narratives.json` valid array (possibly empty).

**Staleness gate (BLOCKING — iter-46 lesson):** before exiting Stage 4, verify every feature_id in features-confirmed.json has a corresponding sentiment row:

```bash
features_ids=$(jq -r '.[] | .feature_id' data/features-confirmed.json | sort -u)
sentiment_ids=$(jq -r '.[] | .feature_id' data/feature-sentiment.json | sort -u)
missing=$(comm -23 <(echo "$features_ids") <(echo "$sentiment_ids"))
if [ -n "$missing" ]; then
  echo "❌ STALENESS GATE — these features have no sentiment row, would render to unclear-fold:"
  echo "$missing" | sed 's/^/   - /'
  echo "Fix: re-run Stage 4a for the missing feature_ids before continuing to Stage 5."
  exit 1
fi
echo "✅ staleness gate: all $(echo "$features_ids" | wc -l | tr -d ' ') features keyed in sentiment"
```

Root cause this gate addresses: iter-46 close discovered that a fresh harvest can regenerate features-confirmed.json with content-hash-derived IDs different from prior cycle's IDs. If Stage 4 fails partway (Sonnet schema-incomplete error, Opus session ended, network timeout), the workflow could continue to Stage 5+ with stale sentiment that the renderer silently falls back to "unclear sentiment" for. This gate fails loud at Stage 4 close instead of producing a beautifully-structured-but-empty report.

---

## Stage 5 — Synthesis: creator-recs backfill (inline Opus, only if needed, ~1-2 min)

Check `data/feature-sentiment.json` for rows where `creator_recommendation` is null or missing.

```bash
jq '[.[] | select(.creator_recommendation == null) | .feature_id]' data/feature-sentiment.json
```

If empty array, skip this stage with `⏭️  creator-recs: all rows already populated, skip`.

Otherwise for each missing row: read `prompts/creator-recs.md` as system, build the user prompt from the row's sentiment + the original feature's top-12 items (look up by feature_id in `data/features-confirmed.json`). Synthesize inline. Validate (`creator_recommendation` is either `null` or object with `angle` ≥ 10 chars, `format` in {tutorial,opinion,demo,explainer,reaction,comparison,post-mortem}, `hook` ≥ 8 chars).

Merge results back into `data/feature-sentiment.json` keyed by feature_id.

Narrate: `🎬 creator-recs done · {N_populated} populated · {N_null} honestly null`.

---

## Stage 6 — Synthesis: podcast-themes (inline Opus, ~1-2 min)

Read `data/youtube.json`. Filter items with `meta.transcript` length > 200. Sort deterministically (e.g. by URL). Chunk into batches of 25.

For each chunk:
- Read `prompts/podcast-themes.md` as system
- Build user prompt with each transcript as a [V] block (show name from title, video_id, url, title, first 700 chars of transcript)
- Also include "already-confirmed features" list from `data/features-confirmed.json` (do NOT propose these as themes)
- Synthesize inline → array of themes

Merge all chunk outputs deterministically by themeKey (lowercase, alphanum-only, sort words >3 chars, join with space — see `src/podcast-themes.ts` `themeKey` function for exact spec). Cap at 12 themes sorted by episode_count desc.

Write `data/podcast-themes.json`:
```json
{
  "generated_at": "<ISO>",
  "source_transcript_count": <N>,
  "themes": [ ... ]
}
```

Narrate: `🎙 podcast-themes done · {N_themes} themes across {N_transcripts} transcripts`.

---

## Stage 7 — Synthesis: industry-news (inline Opus, ~2-3 min)

Same shape as podcast-themes but chunk size 15 + uses TWO prompts (per-chunk extract, then cross-chunk merger).

For each chunk:
- Read `prompts/industry-news.md` as system
- Build user prompt with each transcript as [V] block (first 900 chars)
- Synthesize → array of raw events

After all chunks done:
- De-dup raw events against features-confirmed (drop any event whose normalized headline is substring-contained in a feature title with feature-title length ≥ 6 chars; drop if event headline contains any feature entity ≥ 5 chars). Capture dropped records.
- Read `prompts/industry-news-merger.md` as system
- Build user prompt with all kept raw events as [INPUT-N] blocks
- Synthesize → array of merged events
- Filter merged events to `shows.length >= 2`
- Sort by show-count desc, then episode-count desc. Cap at 14.

Write `data/industry-news.json`:
```json
{
  "generated_at": "<ISO>",
  "source_transcript_count": <N_transcripts>,
  "events": [...],
  "dropped": [...],
  "pipeline_stats": {
    "chunks_run": <N_chunks>,
    "chunks_failed": 0,
    "raw_events_extracted": <N_raw>,
    "events_after_dedup": <N_kept>,
    "events_after_aggregation": <N_final>
  }
}
```

Narrate: `📰 industry-news done · {N_final} events from {N_raw} raw · {N_dropped} dropped as feature-overlap`.

---

## Stage 8 — Deterministic: classify-one-to-watch (~5 sec)

```bash
time bun scripts/classify-one-to-watch.ts 2>&1 | tail -5
```

This is fully deterministic (regex + bucket math, no LLM). Writes `data/one-to-watch.json`.

Verify:
```bash
jq '{predict_ahead: (.classifications | map(select(.bucket=="predict-ahead")) | length), today: (.classifications | map(select(.bucket=="today")) | length)}' data/one-to-watch.json
```

Narrate: `🔮 one-to-watch done · {N_predict_ahead} predict-ahead · {N_today} today · {N_hustler} hustler`.

---

## Stage 9 — Deterministic: fetch-captions-and-match (~5-30 sec)

```bash
time bun run features:captions 2>&1 | tail -5
```

Pure code; matches existing transcripts against feature entities and emits caption data the renderer uses.

Narrate: `🎞 captions done`.

---

## Stage 10 — Render (deterministic, ~2 sec)

```bash
time bun run features:render 2>&1 | tail -5
```

Pure code; reads all `data/*.json` and emits a timestamped file `out/features-confirmed-{anchor-date}.html` (anchor = max ts across harvested data, deterministic per v8). The renderer DOES NOT overwrite `out/features-confirmed.html` (that's the immutable reference baseline included with the bundle so users see the expected structure before running anything).

**Archival rule (Kem 2026-05-26):** every run produces a NEW numbered file. Previous runs are preserved. Do not overwrite anything in `out/` from prior runs. After render, rename the freshly-written timestamped file to include an incrementing run number, then update the `out/latest.html` symlink to point at it:

```bash
# Find the file the renderer just wrote (newest features-confirmed-{anchor}.html that doesn't already have a run-NNN suffix)
freshly_rendered=$(ls -t out/features-confirmed-????-??-??-??-??.html 2>/dev/null | head -1)
test -n "$freshly_rendered" || { echo "FAIL: renderer produced no anchor-dated file"; exit 1; }

# Compute next run number from existing run-NNN files
last_n=$(ls out/features-confirmed-run???-*.html 2>/dev/null | sed -E 's/.*-run([0-9]+)-.*/\1/' | sort -n | tail -1)
next_n=$(printf "%03d" $(( ${last_n:-0} + 1 )))

# Compose new name: features-confirmed-run{NNN}-{anchor}.html, preserving the anchor date for traceability
anchor_part=$(basename "$freshly_rendered" .html | sed -E 's/^features-confirmed-//')
new_name="out/features-confirmed-run${next_n}-${anchor_part}.html"
mv "$freshly_rendered" "$new_name"

# Update latest symlink (relative target so the symlink survives moves of out/)
ln -sf "$(basename "$new_name")" out/latest.html

echo "✅ run #${next_n} → ${new_name}"
echo "✅ out/latest.html → $(readlink out/latest.html)"
```

Verify:
```bash
test -L out/latest.html && test -s "out/$(readlink out/latest.html)" && echo "✅ latest.html points to non-empty file"
grep -c "lens-fold" "out/$(readlink out/latest.html)"
```

Narrate: `🎉 render done · run #${next_n} · out/features-confirmed-run${next_n}-{anchor}.html · {SIZE}KB · {N_lenses} lenses · {N_features} features · linked from out/latest.html`.

The pristine `out/features-confirmed.html` baseline (included with bundle) stays untouched as the structural reference. End-user can `diff` their latest run against the baseline to see what changed across cycles.

---

## Stage 11 — Display

Resolve the latest report path. Try Interceptor first (real Chrome, no CDP detection). Fall back to macOS `open` (default browser). Fall back to printing the path so the user can copy/paste into their browser:

```bash
latest_target=$(readlink out/latest.html)
report_path="$(pwd)/out/${latest_target}"

if command -v interceptor >/dev/null 2>&1; then
  interceptor open "file://${report_path}" --reuse
  open_method="Interceptor (real Chrome)"
elif command -v open >/dev/null 2>&1; then
  open "file://${report_path}" && open_method="default browser"
else
  open_method="manual"
fi
```

**Always** announce the absolute path in the final narration, even if Interceptor or `open` succeeded — recipients without Interceptor need it visible.

Final narration block:
```
🎉 TrendingAI report ready — run #${next_n}
   📄 Path: $(pwd)/out/${latest_target}
   🔗 Latest symlink: $(pwd)/out/latest.html → ${latest_target}
   📏 Size: <SIZE>
   📊 Content: <N> features · <N> cross-narratives · <N> podcast themes · <N> news events
   ⏱  Pipeline: <total wall-clock>
   💰 Hard cost: ~$<amount>
   📁 Prior runs preserved in out/ for cycle-over-cycle compare
   🌐 Opened via: ${open_method}
```

If `open_method == "manual"`, add:
```
   ⚠️  No browser opener found. Copy the path above into your browser address bar (prefix with `file://`).
```

Stop. Do not continue answering with more advice unless the user asks. The report is the deliverable.

---

## Recovery / failure modes

| If this fails | Do this |
|---|---|
| Harvest exits non-zero | Don't continue. Show the error. Most common: APIFY_TOKEN typo, rate-limit, or one specific actor down (which is fine — orchestrator continues without that source). |
| `features-first` produces 0 features | The harvest substrate is too thin OR the entity dictionary missed everything. Surface to user; they can re-run with broader harvest. Do NOT fabricate features. |
| A synthesis JSON fails schema validation twice | Mark that row with `error: "schema-incomplete"` and continue. The renderer handles missing rows gracefully (renders an "unavailable" card). |
| Render fails | Check `data/feature-sentiment.json` is a valid JSON array; check `data/features-confirmed.json` exists. Most common: trailing-comma in a synthesized JSON. Re-validate, re-render. |
| Apify rate-limit mid-harvest | The harvester retries. If it persists, fall back to render-only with whatever data is on disk. |
| `interceptor open` not installed | Skip the open; just print the file path. User can open in browser. |

## What I will NOT do

- Run `claude --print` or `claude -p` for any synthesis call
- Import `@anthropic-ai/sdk` anywhere
- Spawn `Inference.ts` for synthesis
- Skip stages to "save time" — the user is paying for a complete report
- Fabricate citations, quotes, or features
- Edit the renderer (`src/render-features-first.ts`) or the schemas the renderer expects
- Modify any source-data harvesters (Apify actors, yt-dlp config) without explicit user direction
- Claim "done" without tool-verified evidence per stage
