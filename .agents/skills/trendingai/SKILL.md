---
name: trendingai
description: Generate the AI trending report — harvested social/podcast/repo data turned into a structured editorial HTML report through deterministic extraction + inline LLM synthesis. USE WHEN user says any of "/trendingai", "run trendingai", "trending AI report", "AI trending report", "run the report", "let's do our AI trending report", "fresh trendingai run", "full harvest", "render-only report". Prompts for required env vars (APIFY_TOKEN, GROQ_API_KEY) on first fresh run, then executes fresh-harvest (~15-20 min) or render-only (~30 sec) pipeline. Final output is an archival-numbered HTML report in out/ with out/latest.html symlink.
---

# TrendingAI — Multi-Agent Skill (Codex, Pi, OpenCode, Antigravity, Claude Code)

## What this skill does

The user has opened an agent session (OpenAI Codex, Pi, OpenCode, Google Antigravity, or Claude Code) in this repository and invoked `/trendingai` or requested an AI trending report.

The pipeline delivers a freshly-rendered AI trending HTML report end-to-end:
- 4 deterministic extraction/clustering stages (`features-first`, `classify-one-to-watch`, `captions`, `render`)
- 4 synthesis stages (`feature-sentiment`, `cross-narratives`, `podcast-themes`, `industry-news`) executed **inline in the active agent session's context** without subagent spawning or external LLM API keys.

## Routing

When invoked, decide which workflow to execute based on user intent:
- **Default / Fresh harvest** (`/trendingai`, `run trendingai`, `AI trending report`, `fresh harvest`, `full harvest`) → execute [`Workflows/Run.md`](Workflows/Run.md).
- **Render-only** (`render-only`, `render the report`, `re-render`, `use cached data`) → execute [`Workflows/RenderOnly.md`](Workflows/RenderOnly.md).

If ambiguous, prompt the user to choose between Fresh Harvest and Render-Only.

## Non-Negotiable Contract

1. **Inline synthesis:** The model running the current session performs synthesis in turn-by-turn prompts. No spawning of external LLM processes or Task subagents.
2. **Schema validation:** After each synthesis stage, execute `bun scripts/validate-synthesis.ts --stage <name> --file <path>`. Fails loud if invalid.
3. **Frozen surfaces:** Do not edit `src/render-features-first.ts`, `src/features-first.ts`, or deterministic scoring scripts.
4. **Archival numbering:** Never overwrite `out/features-confirmed.html` or prior runs. Create `out/features-confirmed-run{NNN+1}-{date}.html` and update `out/latest.html`.
5. **No hallucinated citations:** Real URLs from harvest data only.
