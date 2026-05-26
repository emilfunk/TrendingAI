# Workflow — RenderOnly (cached-data fast path)

Render the TrendingAI report from whatever `data/*.json` is already on disk. No harvest, no synthesis. Pure deterministic chain: features-first (re-runs to make sure the source matrix is current) → one-to-watch → captions → render. ~30 seconds total.

Used for: structural preview before paying for fresh data, sanity-check of the bundle right after install, regeneration after a renderer-side tweak.

---

## Stage 0 — Env-check + synthesis-staleness gate (lightweight, BLOCKING)

`APIFY_TOKEN` and `GROQ_API_KEY` are NOT required for render-only (no network calls). Skip the questionnaire. Bundle-integrity + ID-alignment check (BLOCKING — render-only must refuse to ship a report where sentiment is keyed to stale feature_ids):

```bash
# 0a — existence
test -d data && test -f data/features-confirmed.json && echo "✅ data/ cached" || { echo "❌ no cached data — must run fresh harvest first"; exit 1; }
test -f data/feature-sentiment.json && echo "✅ sentiment cache" || echo "⚠️  no sentiment cache — renderer will show cards without sentiment panels"

# 0b — features-first re-runs first (it may regenerate features-confirmed.json with new IDs from existing harvest data)
bun run features:first 2>&1 | tail -5

# 0c — synthesis-staleness gate: only fires if sentiment.json EXISTS with stale keys
#       (sentiment.json absent is a valid render-only state — bundle ships without
#        synthesis cache by design; that path renders cards without sentiment panels)
if [ -f data/feature-sentiment.json ]; then
  features_ids=$(jq -r '.[] | .feature_id' data/features-confirmed.json | sort -u)
  sentiment_ids=$(jq -r '.[] | .feature_id' data/feature-sentiment.json | sort -u)
  missing=$(comm -23 <(echo "$features_ids") <(echo "$sentiment_ids"))
  if [ -n "$missing" ]; then
    echo "❌ STALENESS GATE — feature-sentiment.json EXISTS but is missing sentiment for these current features:"
    echo "$missing" | sed 's/^/   - /'
    echo ""
    echo "Render-only would silently route these cards to the unclear-sentiment fold."
    echo "Fix: run fresh synthesis via Workflows/Run.md Stage 4 (inline Opus regen of feature-sentiment.json + cross-narratives.json + industry-news.json on current data/features-confirmed.json). Do NOT continue render-only against stale sentiment."
    exit 1
  fi
  echo "✅ staleness gate: all $(echo "$features_ids" | wc -l | tr -d ' ') features have keyed sentiment"
else
  echo "ℹ️  no sentiment cache — render-only will show cards without sentiment panels (this is fine for bundle smoke-test)"
fi
```

If `data/features-confirmed.json` is absent, the bundle has no cached data; user must run fresh harvest. Surface clearly and stop.

**Why this gate exists (iter-46 root cause):** when a fresh harvest regenerates features-confirmed.json with content-hash-derived IDs, the existing feature-sentiment.json (keyed to prior cycle's IDs) becomes orphaned. The renderer falls back to "unclear sentiment" when it cannot find a sentiment row for a feature_id, silently collapsing every card into the unclear-sentiment fold. The result looks structurally fine (lens nav + tier headers + section structure all present) but every feature card is empty when expanded. This gate catches that mismatch BEFORE rendering, surfacing the requirement to re-run synthesis via `Workflows/Run.md` Stage 4 instead of silently shipping a report with no visible features.

---

## Stage 1 — Render (post-gate; features-first already ran in Stage 0b)

```bash
# The bundle's package.json directory IS the cwd when run via `bun run`.
# All paths in the bundle are relative — no cd needed if you opened claude here.
# features:first ALREADY RAN in Stage 0b before the staleness gate — do not re-run
bun scripts/classify-one-to-watch.ts 2>&1 | tail -5
bun run features:captions 2>&1 | tail -5
bun run features:render 2>&1 | tail -5
```

Then apply the archival rule (same as `Run.md` Stage 10):

```bash
freshly_rendered=$(ls -t out/features-confirmed-????-??-??-??-??.html 2>/dev/null | head -1)
last_n=$(ls out/features-confirmed-run???-*.html 2>/dev/null | sed -E 's/.*-run([0-9]+)-.*/\1/' | sort -n | tail -1)
next_n=$(printf "%03d" $(( ${last_n:-0} + 1 )))
anchor_part=$(basename "$freshly_rendered" .html | sed -E 's/^features-confirmed-//')
new_name="out/features-confirmed-run${next_n}-${anchor_part}.html"
mv "$freshly_rendered" "$new_name"
ln -sf "$(basename "$new_name")" out/latest.html
echo "✅ render-only run #${next_n} → ${new_name}"
```

Narrate: `📄 render-only complete · run #${next_n} · ${new_name}`.

---

## Stage 2 — Display

Resolve report path; try Interceptor, then macOS `open`, fall back to printing the path:

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

Always print the absolute path in the final narration even if a browser opener succeeded — recipients without Interceptor need it visible.

Final narration:
```
📄 Report ready (render-only from cached data) — run #${next_n}
   Path: $(pwd)/out/${latest_target}
   Latest symlink: $(pwd)/out/latest.html → ${latest_target}
   Note: content reflects cached data shipped with the bundle.
   To refresh content with this cycle's data, run a fresh harvest via /trendingai.
   🌐 Opened via: ${open_method}
```

If `open_method == "manual"`, add:
```
   ⚠️  No browser opener found. Copy the path above into your browser address bar (prefix with `file://`).
```

Stop.

---

## What "render-only" does NOT do

- No new harvest. Existing `data/*.json` snapshots are used as-is.
- No synthesis. `data/feature-sentiment.json`, `data/cross-narratives.json`, `data/podcast-themes.json`, `data/industry-news.json`, `data/_envelopes/` are read if present, ignored if absent.
- No `creator_recommendation` generation. Whatever's already in the cached sentiment rows is used.

The deterministic stages (features-first, one-to-watch, captions, render) DO re-run because they're cheap and the renderer needs their outputs to be current with the data snapshot. Re-running them against unchanged input produces byte-identical output.
