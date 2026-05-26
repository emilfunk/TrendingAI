---
name: trendingai
description: Generate the AI trending report — harvested social/podcast/repo data turned into a structured editorial HTML report through deterministic extraction + Opus-orchestrated synthesis. USE WHEN user says any of "/trendingai", "run trendingai", "trending AI report", "AI trending report", "run the report", "let's do our AI trending report", "fresh trendingai run", "full harvest". Skill prompts for required env vars (APIFY_TOKEN, GROQ_API_KEY) on first run, then asks fresh-harvest vs render-only, then runs the pipeline narrated step-by-step (~15-20 min wall-clock for fresh harvest, ~30 sec for render-only). Final output is `out/features-confirmed.html`. NOT FOR: editing the report structure (the renderer is frozen by design), changing the synthesis model (Opus 4.7 by contract), bypassing the questionnaire (env vars are required).
---

# TrendingAI — clone-and-run hackathon bundle

## What this skill does

The user has cloned the bundle, opened Claude Code in the bundle directory, and typed `/trendingai`. From that moment my job is to deliver a freshly-rendered AI trending HTML report end-to-end in one fluid motion. The pipeline has 8 stages — 4 deterministic + 4 synthesis. The synthesis stages used to call Sonnet via `claude --print` subprocess; Anthropic's post-June-15 billing rule change ended subscription-billed `--print`, so synthesis now happens **inline in MY own context (Opus 4.7) — single window, no Task subagents, no spawning, no parallel forks.** I read the prompts at `prompts/*.md` and produce the JSON matching the schemas the renderer expects, one feature at a time, in sequence. The orchestration is one chat; the magic is the substrate (8 stages over harvested data), not a fork-join cleverness.

## Routing

When the user invokes me, decide which workflow to run based on what they said:

- **Trigger phrases** ("/trendingai", "run trendingai", "AI trending report", "trending AI report", "run the report", "let's do our AI trending report") → call `Workflows/Run.md`
- **Fresh-harvest variants** ("fresh trendingai run", "full harvest", "fresh harvest") → call `Workflows/Run.md` with the fresh-harvest branch pre-selected
- **Render-only variants** ("render the report", "re-render", "render-only", "use cached data") → call `Workflows/RenderOnly.md`

If unclear, call `Workflows/Run.md` and let it ask the user (env-var check happens regardless; fresh vs render-only is the second question).

## Voice during the pipeline

Narrate each stage with timestamp + count + status so the user feels the magic but knows what's actually happening. Use the format the workflow specifies — `🌐 harvest started · 12 sources · t=0s` ... `✅ apify pulled 1,340 items · t=47s`. Brevity over chattiness. Stay calm during long stages; do not invent progress numbers. If a stage takes longer than expected, say so — never fake completion.

## Hard rules (non-negotiable)

1. **No `claude --print` for synthesis. No Task subagents. No spawning.** All synthesis happens INLINE in my main context (Opus 4.7 in the user's session). One conversation handles the whole pipeline. No subprocess `claude` calls. No Task-tool agent spawns. Single context, sequential, predictable.
2. **No `@anthropic-ai/sdk`.** The bundle has none of this; if any code anywhere imports the Anthropic SDK, fail loud.
3. **No `ANTHROPIC_API_KEY` env read.** The bundle's `.env.example` documents only `APIFY_TOKEN` + `GROQ_API_KEY`. If the user has an `ANTHROPIC_API_KEY` set in their environment, ignore it — the orchestrating session is the model.
4. **No skipping stages.** All 8 pipeline stages run on a fresh-harvest invocation. Render-only skips harvest + synthesis only.
5. **JSON-schema fidelity is contractual.** Every synthesis stage produces a JSON file that the deterministic renderer reads. Schemas are in the `prompts/*.md` files. After each synthesis stage, validate the output JSON shape via `jq` — if any required key is missing, fail loud and retry.
6. **Determinism preserved on deterministic surfaces.** Re-running the deterministic stages against unchanged input data produces byte-identical output. The synthesis stages WILL produce different bytes across runs (Opus is non-deterministic by design); structural / schema / link-shape / citation-count are what's contractual.
7. **No invented citations.** Synthesis stages cite real URLs from the harvested data only. If a feature has 0 cited items, the rendered card shows what's there honestly; do not fabricate to fill space.
8. **No "should work."** Every stage report carries tool evidence (file written, byte count, jq probe result). "Done" without evidence is not done.

## Cost transparency

Fresh-harvest run hard costs (paid to Apify + Groq):
- Apify (X / TT / IG harvesters): ~$0.10-0.20
- Groq Whisper (IG audio transcription): ~$0.05
- Anthropic Opus (synthesis): $0 marginal — subscription-billed via the running Claude Code session

Total: under $0.30 per fresh run. Render-only is $0.

The workflow announces estimated spend before the harvest fires and pauses for user confirmation. Free-tier Apify ($5 credit) covers ~15-25 fresh runs.

## Time transparency

Fresh harvest end-to-end target: <25 minutes wall-clock.
- Harvest: 5-8 min (depends on yt-dlp throughput + Apify queues)
- Features-first deterministic extraction: 10-15 sec
- Synthesis stages (inline): 8-12 min total
  - feature-sentiment (14 features inline): 4-7 min
  - cross-narratives (single pass): 30-60 sec
  - creator-recs backfill (only if needed): 1-2 min
  - podcast-themes (3 chunks): 1-2 min
  - industry-news (4 chunks + merger): 2-3 min
- Classify-one-to-watch (deterministic): 5 sec
- Captions match (deterministic): 5-30 sec
- Renderer (deterministic): 2 sec

Render-only: under 30 sec total.

## What the user sees

A series of narrated stage updates as the pipeline runs, then a `🎉 Report ready · out/features-confirmed.html · 475 KB · 14 features · 9 lenses` summary, then I open the report with Interceptor for them to read.

## What "done" looks like

The user has `out/features-confirmed-runNNN-{date}.html` on disk, opened in their browser, reading the AI trending report with this cycle's content. The same shape as the bundled `out/features-confirmed.html` baseline reference, but with today's harvested data and Opus-synthesized editorial. They feel like a lot happened because a lot DID happen, narrated step by step as it landed.
