# Workflow — Run (full pipeline orchestration)

The canonical TrendingAI pipeline workflow. Invoked when user requests the AI trending report or runs `/trendingai`. Walks through env-check → fresh-vs-render choice → harvest (if fresh) → features-first → 4 synthesis stages (inline LLM session) → 2 deterministic post-stages → render → display.

This file is the operating manual for the orchestrating agent session. Read top-to-bottom before acting. Each `### Stage N` block is one operation with a stop condition before moving on.

---

## Stage 0 — Env-var questionnaire

Read the bundle's `.env` if it exists, else read environment. Check for `APIFY_TOKEN` and `GROQ_API_KEY`. Both must be set for a fresh harvest.

```bash
# Check the bundle's .env
if [ -f ./.env ]; then
  set -a; source ./.env; set +a
fi
# Validate
test -n "$APIFY_TOKEN" && echo "✅ APIFY_TOKEN set" || echo "❌ APIFY_TOKEN missing"
test -n "$GROQ_API_KEY" && echo "✅ GROQ_API_KEY set" || echo "❌ GROQ_API_KEY missing"
```

If either is missing, ask the user (using the active runtime's interactive question tool or conversational prompt):
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

**Stop condition:** both env vars validated. If user refuses to provide one, offer render-only or halt.

---

## Stage 1 — Fresh-harvest vs render-only

Prompt the user to choose:
- **Fresh harvest** — runs all 12 source harvesters + full synthesis + render. ~15-20 min. ~$0.30 hard cost.
- **Render-only** — uses cached `data/*.json` from the bundle. ~30 sec. $0 cost.

If "Render-only", switch to `Workflows/RenderOnly.md`.

If "Fresh harvest", confirm cost expectation: `📊 Estimated cost ~$0.15-$0.30 hard $ (Apify + Groq). LLM synthesis is $0 marginal (subscription-billed in session). Free Apify tier ($5 credit) covers ~15-25 runs.` Then continue.

---

## Stage 2 — Harvest (fresh path only, ~5-8 min)

```bash
mkdir -p data/raw
time bun run harvest:all 2>&1 | tee /tmp/trendingai-harvest.log
```

Narrate: `🌐 harvest started · 12 sources in parallel · t=0s`. Watch progress.
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

**Stop condition:** non-empty harvest with at least x.json, tiktok.json, youtube.json, frontier.json present.

---

## Stage 3 — Features-first (deterministic, ~15 sec)

```bash
time bun run features:first 2>&1 | tail -10
```

Extracts entities, matches cross-platform, filters by threshold, and writes `data/features-confirmed.json`.

Verify:
```bash
jq 'length' data/features-confirmed.json
jq '[.[].title]' data/features-confirmed.json
```

**Stop condition:** `data/features-confirmed.json` exists and has length ≥ 1.

---

## Stage 4 — Synthesis: feature-sentiment + cross-narratives (inline LLM session, ~5-8 min)

**INLINE SYNTHESIS:** All synthesis happens inside the orchestrating agent conversation turn-by-turn. No Task subagents, no external subprocess spawns.

### 4a — Per-feature pass

1. Build envelopes:
```bash
bun scripts/build-sentiment-envelopes.ts
```
Writes envelopes to `/tmp/sentiment-envelopes/{feature_id}.txt`.

2. For each feature in `data/features-confirmed.json`:
- Read `prompts/feature-sentiment.md` for the system context and schema.
- Read `/tmp/sentiment-envelopes/{feature_id}.txt`.
- Synthesize JSON output matching schema in `prompts/feature-sentiment.md`.
- Write to `data/_envelopes/feature-sentiment/{feature_id}.json`.

3. Aggregate:
```bash
jq -s '.' data/_envelopes/feature-sentiment/*.json > data/feature-sentiment.json
```

4. Validate:
```bash
bun scripts/validate-synthesis.ts --stage feature-sentiment --file data/feature-sentiment.json
```

### 4b — Cross-narrative pass

1. Read `prompts/cross-narratives.md`.
2. Read `data/feature-sentiment.json`.
3. Synthesize `data/cross-narratives.json`.
4. Validate:
```bash
bun scripts/validate-synthesis.ts --stage cross-narratives --file data/cross-narratives.json
```
5. Update `data/feature-sentiment.json` rows with implicated `cross_narrative_ids`.

### 4c — Staleness Gate (BLOCKING)
Verify every feature in `features-confirmed.json` has a corresponding sentiment row:
```bash
features_ids=$(jq -r '.[] | .feature_id' data/features-confirmed.json | sort -u)
sentiment_ids=$(jq -r '.[] | .feature_id' data/feature-sentiment.json | sort -u)
missing=$(comm -23 <(echo "$features_ids") <(echo "$sentiment_ids"))
if [ -n "$missing" ]; then
  echo "❌ STALENESS GATE — missing sentiment for:"
  echo "$missing" | sed 's/^/   - /'
  exit 1
fi
echo "✅ staleness gate passed"
```

---

## Stage 5 — Synthesis: creator-recs backfill (inline LLM session, ~1-2 min)

Check if any row in `data/feature-sentiment.json` has `creator_recommendation == null`. If so, synthesize using `prompts/creator-recs.md` and validate with:
```bash
bun scripts/validate-synthesis.ts --stage creator-recs --file data/feature-sentiment.json
```

---

## Stage 6 — Synthesis: podcast-themes (inline LLM session, ~1-2 min)

Filter YouTube items with transcript length > 200 chars. Batch into chunks of 25.
For each chunk, synthesize themes using `prompts/podcast-themes.md`.
Merge and write `data/podcast-themes.json`.
Validate:
```bash
bun scripts/validate-synthesis.ts --stage podcast-themes --file data/podcast-themes.json
```

---

## Stage 7 — Synthesis: industry-news (inline LLM session, ~2-3 min)

Filter transcripts in chunks of 15.
Extract raw events using `prompts/industry-news.md`.
Merge across chunks using `prompts/industry-news-merger.md`.
Write `data/industry-news.json`.
Validate:
```bash
bun scripts/validate-synthesis.ts --stage industry-news --file data/industry-news.json
```

---

## Stage 8 — Deterministic: classify-one-to-watch (~5 sec)

```bash
bun scripts/classify-one-to-watch.ts 2>&1 | tail -5
```
Writes `data/one-to-watch.json`.

---

## Stage 9 — Deterministic: captions match (~5-30 sec)

```bash
bun run features:captions 2>&1 | tail -5
```

---

## Stage 10 — Render (deterministic, ~2 sec)

```bash
bun run features:render 2>&1 | tail -5
```

Apply monotonic run numbering and update symlink:
```bash
freshly_rendered=$(ls -t out/features-confirmed-????-??-??-??-??.html 2>/dev/null | head -1)
test -n "$freshly_rendered" || { echo "FAIL: renderer produced no anchor-dated file"; exit 1; }

last_n=$(ls out/features-confirmed-run???-*.html 2>/dev/null | sed -E 's/.*-run([0-9]+)-.*/\1/' | sort -n | tail -1)
next_n=$(printf "%03d" $(( ${last_n:-0} + 1 )))

anchor_part=$(basename "$freshly_rendered" .html | sed -E 's/^features-confirmed-//')
new_name="out/features-confirmed-run${next_n}-${anchor_part}.html"
mv "$freshly_rendered" "$new_name"

ln -sf "$(basename "$new_name")" out/latest.html
echo "✅ run #${next_n} → ${new_name}"
```

---

## Stage 11 — Display

Resolve report path and open in browser:
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

Announce absolute path, run number, file size, content counts, wall-clock time, and estimated hard cost.
