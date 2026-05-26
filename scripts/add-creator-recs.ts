// scripts/add-creator-recs.ts — post-process pass that reads existing
// data/feature-sentiment.json + data/features-confirmed.json, and for each row
// that lacks creator_recommendation, makes a focused Sonnet call to add it.
//
// Built iter-32 because the v1 + v2 feature-sentiment.ts runs returned valid
// JSON from Sonnet but the persistence layer (processFeature return) did not
// enumerate creator_recommendation, so the field was silently dropped both
// times. Bug fixed in src/feature-sentiment.ts for future full runs; this
// script unblocks iter-32 close without paying the 8-min re-run cost.
//
// Cheaper too: ~13 small per-feature Sonnet calls (~3-8s each at concurrency
// 3) vs a full feature-sentiment re-run (~8 min and clobbers cross-narratives).

import * as fs from "node:fs";
import { spawn } from "node:child_process";

const HOME = process.env.HOME!;
const DATA = `${process.cwd()}/data`;
const TIMEOUT_MS = 180_000;
const CONCURRENCY = 3;
const MAX_RESPONSE_ITEMS_PER_FEATURE = 12;
const MAX_CHARS_PER_ITEM = 400;

interface SentimentRow {
  feature_id: string;
  feature_title: string;
  sample_size: number;
  overall_sentiment: string;
  dominant_pattern?: string;
  summary_sentence: string;
  praises: string[];
  complaints: string[];
  notable_quotes: { author: string; source: string; quote: string }[];
  counter_narratives?: string[];
  creator_recommendation?: {
    angle: string;
    format: "tutorial" | "opinion" | "demo" | "explainer" | "reaction" | "comparison" | "post-mortem";
    hook: string;
  } | null;
  [k: string]: unknown;
}

interface ResponseItem {
  source: string;
  author: string;
  url: string;
  title: string;
  matched_entity: string;
  engagement: number;
  raw_text?: string;
}

interface ConfirmedFeature {
  feature_id: string;
  lab: string;
  title: string;
  url: string;
  entities: string[];
  responses: ResponseItem[];
  distinct_platforms: number;
  distinct_creators: number;
  podcast_mentions: number;
}

const VALID_FORMATS = new Set(["tutorial", "opinion", "demo", "explainer", "reaction", "comparison", "post-mortem"]);

const SYS = `You generate exactly ONE creator_recommendation for a single AI lab feature, based on the editorial sentiment already extracted for it. Output strict JSON only — no preamble, no trailing prose.

Schema:
{
  "creator_recommendation": {
    "angle": "string — 15-30 word angle a content-creator could take that ISN'T already saturated in the existing reactions; must be grounded in the actual sentiment / complaints / counter-narratives provided. NEVER generic 'make a tutorial' or 'do an explainer'.",
    "format": "string — exactly one of: tutorial, opinion, demo, explainer, reaction, comparison, post-mortem",
    "hook": "string — the actual opening line of that piece (8-20 words). Voice-driven, specific, would actually land. NOT 'In this video we explore...' boilerplate."
  }
}

If the supplied context genuinely cannot support a grounded recommendation (sample too small, all items off-topic, no real signal), return:
{ "creator_recommendation": null }

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

Output JSON only. No prose.`;

function loadFeaturesByID(): Map<string, ConfirmedFeature> {
  const arr: ConfirmedFeature[] = JSON.parse(fs.readFileSync(`${DATA}/features-confirmed.json`, "utf-8"));
  const m = new Map<string, ConfirmedFeature>();
  for (const f of arr) m.set(f.feature_id, f);
  return m;
}

function buildPrompt(row: SentimentRow, feature: ConfirmedFeature): string {
  const items = (feature.responses ?? [])
    .slice()
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, MAX_RESPONSE_ITEMS_PER_FEATURE)
    .map((r, i) => `[${i + 1}] @${r.author || "?"} · ${r.source} · ${r.engagement} eng · ${(r.title || r.raw_text || "").slice(0, MAX_CHARS_PER_ITEM)}`)
    .join("\n");
  const praises = (row.praises ?? []).map((p) => `  • ${p}`).join("\n") || "  (none)";
  const complaints = (row.complaints ?? []).map((c) => `  • ${c}`).join("\n") || "  (none)";
  const counter = (row.counter_narratives ?? []).map((c) => `  ↩ ${c}`).join("\n") || "  (none)";
  return `FEATURE: ${feature.lab} — ${feature.title}
LAB URL: ${feature.url}

SENTIMENT EXTRACTED:
- overall: ${row.overall_sentiment}
- dominant_pattern: ${row.dominant_pattern ?? "?"}
- summary: ${row.summary_sentence}
- praises:
${praises}
- complaints:
${complaints}
- counter_narratives:
${counter}

TOP ${Math.min(MAX_RESPONSE_ITEMS_PER_FEATURE, feature.responses?.length ?? 0)} ITEMS (for grounding only):
${items}

Generate one creator_recommendation per the rules above. JSON only.`;
}

function ask(systemPrompt: string, userPrompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      [
        `${HOME}/.claude/PAI/TOOLS/Inference.ts`,
        "--level",
        "standard",
        "--timeout",
        String(TIMEOUT_MS),
        systemPrompt,
        userPrompt,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timeout after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS + 5_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`exit ${code}: ${err.slice(0, 200)}`));
      resolve(out.trim());
    });
  });
}

function parseJson(raw: string): { creator_recommendation?: unknown } | null {
  let t = raw.trim();
  const fence = t.match(/```(?:json)?\s*\n([\s\S]+?)\n\s*```/);
  if (fence) t = fence[1]!;
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try { return JSON.parse(t.slice(first, last + 1)); } catch { return null; }
}

function validateCreatorRec(raw: unknown): SentimentRow["creator_recommendation"] {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const cr = raw as { angle?: unknown; format?: unknown; hook?: unknown };
  if (typeof cr.angle !== "string" || cr.angle.trim().length < 10) return null;
  if (typeof cr.format !== "string" || !VALID_FORMATS.has(cr.format)) return null;
  if (typeof cr.hook !== "string" || cr.hook.trim().length < 8) return null;
  return {
    angle: cr.angle.trim(),
    format: cr.format as NonNullable<SentimentRow["creator_recommendation"]>["format"],
    hook: cr.hook.trim(),
  };
}

async function processRow(row: SentimentRow, feature: ConfirmedFeature): Promise<SentimentRow["creator_recommendation"]> {
  const userPrompt = buildPrompt(row, feature);
  try {
    const raw = await ask(SYS, userPrompt);
    const parsed = parseJson(raw);
    if (!parsed) return null;
    return validateCreatorRec(parsed.creator_recommendation);
  } catch (e) {
    console.error(`  [${row.feature_id}] Sonnet call failed: ${(e as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  const rows: SentimentRow[] = JSON.parse(fs.readFileSync(`${DATA}/feature-sentiment.json`, "utf-8"));
  const featuresById = loadFeaturesByID();
  console.log(`add-creator-recs: ${rows.length} sentiment rows, ${featuresById.size} features in registry`);

  const todo = rows.filter((r) => !r.creator_recommendation);
  console.log(`${todo.length} rows missing creator_recommendation; filling at concurrency ${CONCURRENCY}`);

  let i = 0;
  let okCount = 0;
  let nullCount = 0;
  async function worker(): Promise<void> {
    while (i < todo.length) {
      const idx = i++;
      const row = todo[idx]!;
      const feature = featuresById.get(row.feature_id);
      if (!feature) {
        console.warn(`  [${row.feature_id}] feature missing from features-confirmed.json; skipping`);
        continue;
      }
      const t0 = Date.now();
      const cr = await processRow(row, feature);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      row.creator_recommendation = cr;
      if (cr) {
        okCount += 1;
        console.log(`  [${idx + 1}/${todo.length}] ${row.feature_id} → ${cr.format} (${dt}s)`);
      } else {
        nullCount += 1;
        console.log(`  [${idx + 1}/${todo.length}] ${row.feature_id} → null (${dt}s)`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  fs.writeFileSync(`${DATA}/feature-sentiment.json`, JSON.stringify(rows, null, 2));
  console.log(`wrote ${rows.length} rows back → data/feature-sentiment.json (${okCount} populated · ${nullCount} null)`);
}

if (import.meta.main) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
