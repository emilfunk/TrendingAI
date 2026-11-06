# Workflow — RenderOnly (cached-data fast path)

Render the TrendingAI report from cached `data/*.json` already on disk. No harvest, no synthesis. Pure deterministic chain: features-first → one-to-watch → captions → render. ~30 seconds total.

Used for: structural preview before paying for fresh data, sanity-check of the bundle, regeneration after code updates.

---

## Stage 0 — Env-check & Synthesis-Staleness Gate (BLOCKING)

`APIFY_TOKEN` and `GROQ_API_KEY` are NOT required for render-only (no network calls).

```bash
# 0a — Check data directory
test -d data && test -f data/features-confirmed.json && echo "✅ data/ cached" || { echo "❌ no cached data — must run fresh harvest first"; exit 1; }

# 0b — Run features-first to align IDs with current harvest
bun run features:first 2>&1 | tail -5

# 0c — Staleness gate: if sentiment exists, ensure it matches current features
if [ -f data/feature-sentiment.json ]; then
  features_ids=$(jq -r '.[] | .feature_id' data/features-confirmed.json | sort -u)
  sentiment_ids=$(jq -r '.[] | .feature_id' data/feature-sentiment.json | sort -u)
  missing=$(comm -23 <(echo "$features_ids") <(echo "$sentiment_ids"))
  if [ -n "$missing" ]; then
    echo "❌ STALENESS GATE — feature-sentiment.json is missing keys for current features:"
    echo "$missing" | sed 's/^/   - /'
    echo "Re-run synthesis or fresh harvest before rendering."
    exit 1
  fi
  echo "✅ staleness gate passed"
fi
```

---

## Stage 1 — Render

```bash
bun scripts/classify-one-to-watch.ts 2>&1 | tail -5
bun run features:captions 2>&1 | tail -5
bun run features:render 2>&1 | tail -5
```

Apply monotonic run numbering and update symlink:
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

---

## Stage 2 — Display

Open the rendered report:
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

Print summary with absolute path and run number.
