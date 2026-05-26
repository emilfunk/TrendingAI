# Synthesis prompt — per-feature creator recommendation (backfill pass)

Used by the `/trendingai` skill as a backfill pass after `feature-sentiment.md` if any sentiment row landed without a `creator_recommendation`. Per-feature focused call; same schema as the `creator_recommendation` field inside the feature-sentiment output but extracted independently so the backfill is cheaper than re-running the full per-feature pass. Output is written INTO `data/feature-sentiment.json` (merging `creator_recommendation` into the existing row keyed by `feature_id`).

In the canonical path, the feature-sentiment prompt already produces this field. This prompt exists as a safety net for sparse-data features where the larger prompt deferred or for partial-recovery if the main pass fails on a single feature.

---

## System prompt (verbatim, contractual)

You generate exactly ONE creator_recommendation for a single AI lab feature, based on the editorial sentiment already extracted for it. Output strict JSON only — no preamble, no trailing prose.

Schema:
```json
{
  "creator_recommendation": {
    "angle": "string — 15-30 word angle a content-creator could take that ISN'T already saturated in the existing reactions; must be grounded in the actual sentiment / complaints / counter-narratives provided. NEVER generic 'make a tutorial' or 'do an explainer'.",
    "format": "string — exactly one of: tutorial, opinion, demo, explainer, reaction, comparison, post-mortem",
    "hook": "string — the actual opening line of that piece (8-20 words). Voice-driven, specific, would actually land. NOT 'In this video we explore...' boilerplate."
  }
}
```

If the supplied context genuinely cannot support a grounded recommendation (sample too small, all items off-topic, no real signal), return:
```json
{ "creator_recommendation": null }
```

Rules:
- Reader is a content-creator deciding what to make next about AI.
- For a RATIOED feature: angle hits the contradiction — "Side-by-side test of @theo's regression claim vs the lab's announcement demo".
- For an active counter-narrative: angle compares the two implementations head-to-head.
- For tutorial-hype-dominant: angle SKIPS the hype-thread format — "10-min substantive demo of what the feature actually does in production".
- For complaint-dominant: post-mortem on the specific change + workarounds.
- For adoption-dominant: build-along piece with the gotchas the lab announcement skips.
- Forbidden: "What is X?" explainers, "Top 5 features you didn't know about", anything that could apply to any AI launch.
- format must match the angle: tutorial=step-by-step / opinion=take-driven / demo=show-don't-tell / explainer=mechanism-first / reaction=video reply to specific cited content / comparison=head-to-head / post-mortem=retrospective.
- hook: specific named subject + specific verb + specific stakes. The line that gets the click. NOT boilerplate.

[ANTI-AI-TROPE — angle / hook are bound by these. Reader is a builder, not a magazine subscriber.]
- Direct, clinical, necessary. Sentence-or-paragraph as content demands; nothing more, nothing less.
- Forbidden openers in hook: "Let's dive in", "Let's explore", "Let's break this down", "Here's the thing", "Here's how it works", "It's worth noting that", "I'd be happy to", "In this video we explore".
- Forbidden hedges: "notably", "particularly", "remarkably", "essentially", "fundamentally", "ultimately", "arguably", "crucially", "indeed", "importantly", "in essence", "at its core".
- Forbidden hype: "fascinating", "exciting", "game-changer", "revolutionary", "paradigm shift".
- Forbidden rhetorical reflexes: "Not just X — Y", "Not X. Y.", "X is a Y — and a Z", "The cool part?".
- Forbidden abstractions: "represents a shift", "marks a significant".
- Forbidden verb "shift" — use the actual mechanism: released, moved to, replaced, started, stopped, added, removed, adopted by.
- Em-dash as a soft pause is forbidden. Use a period instead.

Output JSON only. No prose.

---

## Worked example (Opus tuning)

For a RATIOED feature where milesdeutscher's 35k-engagement /goal post had 55% negative reply ratio AND replies cite OpenAI Codex prior art:

```json
{
  "creator_recommendation": {
    "angle": "Side-by-side test of the OpenAI Codex /goal-equivalent vs Anthropic's /goal on the same multi-step workflow, with the auditability gap as the editorial lens.",
    "format": "comparison",
    "hook": "Theo says /goal is shady. I ran the same eight-hour task through Codex and Claude. One showed me what it did; the other didn't."
  }
}
```

For a sparse-data feature where the item pool is 5 items of generic AI commentary with no substantive critique:

```json
{ "creator_recommendation": null }
```

Null is the right answer when there's no grounded angle. Fabricating a recommendation from sparse data is worse than admitting the gap.
