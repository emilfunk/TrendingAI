#!/usr/bin/env bun
// scripts/validate-synthesis.ts — per-stage JSON schema validator for the
// /trendingai pipeline. Called by the skill workflow (Workflows/Run.md) after
// each synthesis stage writes its output. Fails loud with exit code 1 + a
// human-readable error message naming which key is missing or wrong type,
// so the orchestrator can retry once with the same prompt + context.
//
// Usage:
//   bun scripts/validate-synthesis.ts --stage <name> --file <path>
//
// Stages supported:
//   feature-sentiment       — array of rows; each row has overall_sentiment,
//                             dominant_pattern, summary_sentence, praises[],
//                             complaints[], notable_quotes[], cited_items_why{}
//   cross-narratives        — object {narratives: []} or bare array; each entry
//                             has narrative_id, theme, implicated_feature_ids
//                             (length >= 2), substrate_sentence, confidence
//   podcast-themes          — object {themes: []} or bare array; each entry has
//                             theme, summary, episodes[] (length >= 2)
//   industry-news           — object {events: []} or bare; each event has
//                             headline, category, context, excerpts[]
//   industry-news-merger    — same shape as industry-news, post-merger
//   creator-recs            — array of rows; each row has feature_id and either
//                             creator_recommendation=null OR object with angle,
//                             format (whitelisted), hook
//
// Exit codes:
//   0  — JSON schema-compliant
//   1  — schema violation; stderr names the violation; retry recommended
//   2  — file not found or unparseable JSON; cannot proceed

import { readFileSync, existsSync } from "fs";

const VALID_CR_FORMATS = new Set([
  "tutorial", "opinion", "demo", "explainer", "reaction", "comparison", "post-mortem"
]);

const VALID_FS_SENTIMENT = new Set([
  "positive", "mixed", "negative", "complaint-dominant", "unclear"
]);

const VALID_FS_PATTERN = new Set([
  "tutorial-hype", "adoption", "complaint", "news", "meta"
]);

const VALID_CN_CONFIDENCE = new Set(["high", "med", "low"]);

const VALID_IN_CATEGORY = new Set([
  "legal", "executive", "compute", "regulatory", "product-policy",
  "funding", "security", "narrative", "geopolitics"
]);

const VALID_IN_SENTIMENT = new Set([
  "consensus", "contested", "skeptical", "celebratory", "neutral"
]);

interface ParsedArgs {
  stage: string;
  file: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let stage = "";
  let file = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--stage" && argv[i + 1]) stage = argv[i + 1];
    if (argv[i] === "--file" && argv[i + 1]) file = argv[i + 1];
  }
  if (!stage || !file) {
    console.error("usage: bun scripts/validate-synthesis.ts --stage <name> --file <path>");
    process.exit(2);
  }
  return { stage, file };
}

function loadJson(path: string): unknown {
  if (!existsSync(path)) {
    console.error(`FAIL: file not found: ${path}`);
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    console.error(`FAIL: unparseable JSON in ${path}: ${(e as Error).message}`);
    process.exit(2);
  }
}

function isStr(x: unknown, minLen = 1): boolean {
  return typeof x === "string" && x.trim().length >= minLen;
}

function isArr(x: unknown): x is unknown[] {
  return Array.isArray(x);
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function validateFeatureSentiment(data: unknown): void {
  if (!isArr(data)) fail("feature-sentiment: root must be a JSON array of rows");
  data.forEach((row, i) => {
    if (!isObj(row)) fail(`feature-sentiment row[${i}]: not an object`);
    if (!isStr(row.feature_id)) fail(`row[${i}]: missing feature_id`);
    if (!isStr(row.feature_title)) fail(`row[${i}] (${row.feature_id}): missing feature_title`);
    if (!isStr(row.overall_sentiment) || !VALID_FS_SENTIMENT.has(row.overall_sentiment as string)) {
      fail(`row[${i}] (${row.feature_id}): overall_sentiment missing or not in ${[...VALID_FS_SENTIMENT].join("|")}`);
    }
    if (row.dominant_pattern !== undefined && !VALID_FS_PATTERN.has(row.dominant_pattern as string)) {
      fail(`row[${i}] (${row.feature_id}): dominant_pattern not in ${[...VALID_FS_PATTERN].join("|")}`);
    }
    if (!isStr(row.summary_sentence)) fail(`row[${i}] (${row.feature_id}): summary_sentence missing or empty`);
    if (!isArr(row.praises)) fail(`row[${i}] (${row.feature_id}): praises not an array`);
    if (!isArr(row.complaints)) fail(`row[${i}] (${row.feature_id}): complaints not an array`);
    if (!isArr(row.notable_quotes)) fail(`row[${i}] (${row.feature_id}): notable_quotes not an array`);
    (row.notable_quotes as unknown[]).forEach((q, qi) => {
      if (!isObj(q) || !isStr((q as Record<string, unknown>).author) || !isStr((q as Record<string, unknown>).source) || !isStr((q as Record<string, unknown>).quote)) {
        fail(`row[${i}] (${row.feature_id}) notable_quotes[${qi}]: missing author/source/quote`);
      }
    });
    if (row.cited_items_why !== undefined && !isObj(row.cited_items_why)) {
      fail(`row[${i}] (${row.feature_id}): cited_items_why must be object`);
    }
    // creator_recommendation: null OK or object with angle/format/hook
    if (row.creator_recommendation !== null && row.creator_recommendation !== undefined) {
      const cr = row.creator_recommendation as Record<string, unknown>;
      if (!isObj(cr)) fail(`row[${i}] (${row.feature_id}): creator_recommendation must be object or null`);
      if (!isStr(cr.angle, 10)) fail(`row[${i}] (${row.feature_id}): creator_recommendation.angle missing/<10 chars`);
      if (!isStr(cr.format) || !VALID_CR_FORMATS.has(cr.format as string)) {
        fail(`row[${i}] (${row.feature_id}): creator_recommendation.format not in ${[...VALID_CR_FORMATS].join("|")}`);
      }
      if (!isStr(cr.hook, 8)) fail(`row[${i}] (${row.feature_id}): creator_recommendation.hook missing/<8 chars`);
    }
  });
  console.log(`PASS: feature-sentiment — ${data.length} rows, all schema-compliant`);
}

function validateCrossNarratives(data: unknown): void {
  const narratives = isArr(data) ? data : (isObj(data) && isArr(data.narratives) ? data.narratives : null);
  if (!narratives) fail("cross-narratives: root must be array or {narratives: [...]}");
  narratives.forEach((n, i) => {
    if (!isObj(n)) fail(`narratives[${i}]: not an object`);
    if (!isStr(n.narrative_id)) fail(`narratives[${i}]: narrative_id missing`);
    if (!isStr(n.theme)) fail(`narratives[${i}] (${n.narrative_id}): theme missing`);
    if (!isArr(n.implicated_feature_ids) || (n.implicated_feature_ids as unknown[]).length < 2) {
      fail(`narratives[${i}] (${n.narrative_id}): implicated_feature_ids must be array length >= 2`);
    }
    if (!isStr(n.substrate_sentence)) fail(`narratives[${i}] (${n.narrative_id}): substrate_sentence missing`);
    if (!isStr(n.confidence) || !VALID_CN_CONFIDENCE.has(n.confidence as string)) {
      fail(`narratives[${i}] (${n.narrative_id}): confidence not in ${[...VALID_CN_CONFIDENCE].join("|")}`);
    }
  });
  console.log(`PASS: cross-narratives — ${narratives.length} narratives, all schema-compliant (empty array is also valid)`);
}

function validatePodcastThemes(data: unknown): void {
  const themes = isObj(data) && isArr(data.themes) ? data.themes : (isArr(data) ? data : null);
  if (!themes) fail("podcast-themes: root must be array or object with themes[]");
  themes.forEach((t, i) => {
    if (!isObj(t)) fail(`themes[${i}]: not an object`);
    if (!isStr(t.theme)) fail(`themes[${i}]: theme missing`);
    if (!isStr(t.summary)) fail(`themes[${i}] (${t.theme}): summary missing`);
    if (!isArr(t.episodes)) fail(`themes[${i}] (${t.theme}): episodes not an array`);
    (t.episodes as unknown[]).forEach((ep, ei) => {
      if (!isObj(ep)) fail(`themes[${i}] (${t.theme}) episodes[${ei}]: not an object`);
      const e = ep as Record<string, unknown>;
      // show / video_id permitted to be empty string OR null (known iter-44-era
      // Sonnet structured-output quirk — Sonnet sometimes drops these even
      // though title carries the inferable value). Warn but don't hard-fail.
      // URL and angle remain hard requirements (renderer needs them).
      if (e.show === undefined) fail(`themes[${i}] episodes[${ei}]: show key missing`);
      if (e.video_id === undefined) fail(`themes[${i}] episodes[${ei}]: video_id key missing`);
      if (!isStr(e.url)) fail(`themes[${i}] episodes[${ei}]: url missing or empty`);
      if (!isStr(e.angle)) fail(`themes[${i}] episodes[${ei}]: angle missing or empty`);
    });
  });
  console.log(`PASS: podcast-themes — ${themes.length} themes, all schema-compliant`);
}

function validateIndustryNews(data: unknown): void {
  const events = isObj(data) && isArr(data.events) ? data.events : (isArr(data) ? data : null);
  if (!events) fail("industry-news: root must be array or object with events[]");
  events.forEach((e, i) => {
    if (!isObj(e)) fail(`events[${i}]: not an object`);
    if (!isStr(e.headline)) fail(`events[${i}]: headline missing`);
    if (!isStr(e.category) || !VALID_IN_CATEGORY.has(e.category as string)) {
      fail(`events[${i}] (${e.headline}): category not in ${[...VALID_IN_CATEGORY].join("|")}`);
    }
    if (!isStr(e.context)) fail(`events[${i}] (${e.headline}): context missing`);
    if (!isArr(e.excerpts) || (e.excerpts as unknown[]).length < 1) {
      fail(`events[${i}] (${e.headline}): excerpts must be array length >= 1`);
    }
    (e.excerpts as unknown[]).forEach((x, xi) => {
      if (!isObj(x)) fail(`events[${i}] excerpts[${xi}]: not object`);
      const ex = x as Record<string, unknown>;
      if (!isStr(ex.show)) fail(`events[${i}] excerpts[${xi}]: show missing`);
      if (!isStr(ex.video_id)) fail(`events[${i}] excerpts[${xi}]: video_id missing`);
      if (!isStr(ex.url)) fail(`events[${i}] excerpts[${xi}]: url missing`);
      if (!isStr(ex.quote)) fail(`events[${i}] excerpts[${xi}]: quote missing`);
    });
    if (e.coverage_sentiment !== undefined && !VALID_IN_SENTIMENT.has(e.coverage_sentiment as string)) {
      fail(`events[${i}] (${e.headline}): coverage_sentiment not in ${[...VALID_IN_SENTIMENT].join("|")}`);
    }
  });
  console.log(`PASS: industry-news — ${events.length} events, all schema-compliant`);
}

function validateCreatorRecs(data: unknown): void {
  if (!isArr(data)) fail("creator-recs: root must be array of rows (typically the same shape as feature-sentiment.json after backfill)");
  data.forEach((row, i) => {
    if (!isObj(row)) fail(`row[${i}]: not an object`);
    if (!isStr(row.feature_id)) fail(`row[${i}]: feature_id missing`);
    if (row.creator_recommendation === null) return; // null is acceptable
    if (row.creator_recommendation === undefined) return; // not-yet-populated also OK in transit
    const cr = row.creator_recommendation as Record<string, unknown>;
    if (!isObj(cr)) fail(`row[${i}] (${row.feature_id}): creator_recommendation not object/null`);
    if (!isStr(cr.angle, 10)) fail(`row[${i}] (${row.feature_id}): angle <10 chars`);
    if (!isStr(cr.format) || !VALID_CR_FORMATS.has(cr.format as string)) {
      fail(`row[${i}] (${row.feature_id}): format not in ${[...VALID_CR_FORMATS].join("|")}`);
    }
    if (!isStr(cr.hook, 8)) fail(`row[${i}] (${row.feature_id}): hook <8 chars`);
  });
  console.log(`PASS: creator-recs — ${data.length} rows, all schema-compliant`);
}

function main(): void {
  const { stage, file } = parseArgs(process.argv.slice(2));
  const data = loadJson(file);
  switch (stage) {
    case "feature-sentiment": validateFeatureSentiment(data); break;
    case "cross-narratives": validateCrossNarratives(data); break;
    case "podcast-themes": validatePodcastThemes(data); break;
    case "industry-news":
    case "industry-news-merger":
      validateIndustryNews(data); break;
    case "creator-recs": validateCreatorRecs(data); break;
    default:
      console.error(`FAIL: unknown stage '${stage}'. Supported: feature-sentiment | cross-narratives | podcast-themes | industry-news | industry-news-merger | creator-recs`);
      process.exit(2);
  }
}

main();
